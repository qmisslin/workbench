#include "diagnostics.h"
#include "nvapi_probe.h"
#include <napi.h>

#include <Windows.h>
#include <d3d11_1.h>
#include <dxgi1_3.h>
#include <wrl/client.h>

#include <array>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <cstring>
#include <mutex>
#include <sstream>
#include <string>
#include <thread>

using Microsoft::WRL::ComPtr;

namespace
{

  constexpr UINT kOutputWidth = 1400;
  constexpr UINT kOutputHeight = 2100;

  constexpr UINT kPackedWidth = kOutputWidth * 2;
  constexpr UINT kPackedHeight = kOutputHeight;

  constexpr wchar_t kWindowClassName[] =
      L"WorkbenchStereoPresenterWindow";

  constexpr wchar_t kWindowTitle[] =
      L"Workbench Stereo Output";

  std::string formatHResult(HRESULT result)
  {
    std::ostringstream stream;

    stream
        << "0x"
        << std::hex
        << std::uppercase
        << static_cast<unsigned long>(result);

    return stream.str();
  }

  LRESULT CALLBACK outputWindowProcedure(
      HWND window,
      UINT message,
      WPARAM wParam,
      LPARAM lParam)
  {
    switch (message)
    {
    case WM_ERASEBKGND:
      /*
       * The swap chain owns the complete window surface.
       */
      return 1;

    case WM_CLOSE:
      /*
       * Hiding the native output window must not terminate Electron.
       */
      ShowWindow(
          window,
          SW_HIDE);

      return 0;

    default:
      return DefWindowProcW(
          window,
          message,
          wParam,
          lParam);
    }
  }

  class StereoPresenter
  {
  public:
    StereoPresenter() = default;

    ~StereoPresenter()
    {
      shutdown();
    }

    HRESULT initialize()
    {
      std::lock_guard<std::mutex> lifecycleLock(
          lifecycleMutex_);

      if (initialized_.load())
      {
        return S_OK;
      }

      /*
       * NVAPI Direct mode must be selected before D3D11CreateDevice().
       *
       * Failure is non-fatal: the presenter continues using the existing DXGI
       * frame-sequential backend.
       */
      nvapiStereo_.initializeBeforeDevice();

      HRESULT result =
          createD3DResources();

      if (FAILED(result))
      {
        resetD3DResources();

        return result;
      }

      /*
       * The NVAPI device handle can only be created after the D3D11 device
       * exists.
       */
      nvapiStereo_.initializeAfterDevice(
          device_.Get());

      stopRequested_.store(
          false);

      presentationError_.store(
          S_OK);

      submittedFrameCount_.store(
          0);

      presentedStereoPairCount_.store(
          0);

      presentedSubframeCount_.store(
          0);

      presentRateMilliHz_.store(
          0);

      {
        std::lock_guard<std::mutex> initializationLock(
            initializationMutex_);

        presentationInitializationCompleted_ =
            false;

        presentationInitializationResult_ =
            E_PENDING;
      }

      presentationThread_ =
          std::thread(
              &StereoPresenter::presentationLoop,
              this);

      {
        std::unique_lock<std::mutex> initializationLock(
            initializationMutex_);

        initializationCondition_.wait(
            initializationLock,
            [this]()
            {
              return presentationInitializationCompleted_;
            });

        result =
            presentationInitializationResult_;
      }

      if (FAILED(result))
      {
        stopRequested_.store(
            true);

        if (presentationThread_.joinable())
        {
          presentationThread_.join();
        }

        resetD3DResources();

        return result;
      }

      initialized_.store(
          true);

      return S_OK;
    }

    HRESULT submit(
        HANDLE sharedHandle,
        D3D11_TEXTURE2D_DESC &importedDescription)
    {
      HRESULT result =
          initialize();

      if (FAILED(result))
      {
        return result;
      }

      const HRESULT presentationError =
          presentationError_.load();

      if (FAILED(presentationError))
      {
        return presentationError;
      }

      /*
       * Only one Electron frame submission may use the shared completion
       * query at a time.
       */
      std::lock_guard<std::mutex> submissionLock(
          submissionMutex_);

      ComPtr<ID3D11Texture2D> sharedTexture;

      /*
       * Electron may provide a different shared resource for every paint
       * event, so the handle is opened for each submitted frame.
       *
       * ID3D11Device itself is free-threaded.
       */
      result =
          device1_->OpenSharedResource1(
              sharedHandle,
              IID_PPV_ARGS(
                  &sharedTexture));

      if (FAILED(result))
      {
        return result;
      }

      sharedTexture->GetDesc(
          &importedDescription);

      result =
          validatePackedTexture(
              importedDescription);

      if (FAILED(result))
      {
        return result;
      }

      /*
       * Keep the state mutex locked until the GPU copy into the inactive
       * stereo slot has completed.
       *
       * The presentation thread can continue displaying the active slot,
       * but it cannot promote the pending slot while it is being written.
       */
      std::unique_lock<std::mutex> stateLock(
          stateMutex_);

      result =
          ensureStereoTextures(
              importedDescription);

      if (FAILED(result))
      {
        return result;
      }

      int writeTextureIndex =
          0;

      if (activeTextureIndex_ == 0)
      {
        writeTextureIndex =
            1;
      }
      else if (activeTextureIndex_ == 1)
      {
        writeTextureIndex =
            0;
      }
      else if (pendingTextureIndex_ == 0)
      {
        writeTextureIndex =
            1;
      }

      /*
       * Copy the complete SBS frame into the inactive texture.
       *
       * The layout is:
       *
       * +----------------------+----------------------+
       * | LEFT                 | RIGHT                |
       * | 1400 x 2100          | 1400 x 2100          |
       * +----------------------+----------------------+
       */
      {
        std::lock_guard<std::mutex> contextLock(
            contextMutex_);

        context_->CopyResource(
            stereoTextures_[writeTextureIndex].Get(),
            sharedTexture.Get());

        context_->End(
            completionQuery_.Get());

        context_->Flush();
      }

      /*
       * Electron is allowed to recycle its shared texture immediately
       * after submitTexture() returns.
       *
       * Wait until our private GPU texture contains the complete frame.
       */
      result =
          waitForGpuCopy();

      if (FAILED(result))
      {
        return result;
      }

      /*
       * Publishing pendingTextureIndex_ is the atomic pair boundary from
       * the application's perspective.
       *
       * LEFT and RIGHT always come from the same Three.js render.
       */
      pendingTextureIndex_ =
          writeTextureIndex;

      importedWidth_.store(
          importedDescription.Width);

      importedHeight_.store(
          importedDescription.Height);

      importedFormat_.store(
          static_cast<UINT>(
              importedDescription.Format));

      submittedFrameCount_.fetch_add(
          1);

      return S_OK;
    }

    uint64_t getSubmittedFrameCount() const
    {
      return submittedFrameCount_.load();
    }

    uint64_t getPresentedStereoPairCount() const
    {
      return presentedStereoPairCount_.load();
    }

    uint64_t getPresentedSubframeCount() const
    {
      return presentedSubframeCount_.load();
    }

    double getPresentRateHz() const
    {
      return static_cast<double>(
                 presentRateMilliHz_.load()) /
             1000.0;
    }

    D3D_FEATURE_LEVEL getFeatureLevel() const
    {
      return featureLevel_;
    }

    UINT getWidth() const
    {
      return importedWidth_.load();
    }

    UINT getHeight() const
    {
      return importedHeight_.load();
    }

    DXGI_FORMAT getFormat() const
    {
      return static_cast<DXGI_FORMAT>(
          importedFormat_.load());
    }

    bool isInitialized() const
    {
      return initialized_.load();
    }

    HRESULT getPresentationError() const
    {
      return presentationError_.load();
    }

    void shutdown()
    {
      std::lock_guard<std::mutex> lifecycleLock(
          lifecycleMutex_);

      if (
          !initialized_.load() &&
          !presentationThread_.joinable() &&
          !device_)
      {
        return;
      }

      stopRequested_.store(
          true);

      if (presentationThread_.joinable())
      {
        presentationThread_.join();
      }

      /*
       * No presentation thread remains after join().
       *
       * The submission lock guarantees that no shared texture copy is
       * still running while resources are destroyed.
       */
      {
        std::lock_guard<std::mutex> submissionLock(
            submissionMutex_);

        /*
         * Destroy the NVAPI device handle while the D3D11 device still exists.
         */
        nvapiStereo_.shutdown();

        resetD3DResources();
      }

      initialized_.store(
          false);

      presentationError_.store(
          S_OK);
    }

  private:
    NvapiStereoBackend nvapiStereo_;

    HRESULT createD3DResources()
    {
      if (device_)
      {
        return S_OK;
      }

      const D3D_FEATURE_LEVEL featureLevels[] = {
          D3D_FEATURE_LEVEL_11_1,
          D3D_FEATURE_LEVEL_11_0,
          D3D_FEATURE_LEVEL_10_1,
          D3D_FEATURE_LEVEL_10_0};

      D3D_FEATURE_LEVEL selectedFeatureLevel;

      const UINT flags =
          D3D11_CREATE_DEVICE_BGRA_SUPPORT;

      HRESULT result =
          D3D11CreateDevice(
              nullptr,
              D3D_DRIVER_TYPE_HARDWARE,
              nullptr,
              flags,
              featureLevels,
              ARRAYSIZE(featureLevels),
              D3D11_SDK_VERSION,
              &device_,
              &selectedFeatureLevel,
              &context_);

      if (FAILED(result))
      {
        return result;
      }

      result =
          device_.As(
              &device1_);

      if (FAILED(result))
      {
        return result;
      }

      D3D11_QUERY_DESC queryDescription = {};

      queryDescription.Query =
          D3D11_QUERY_EVENT;

      queryDescription.MiscFlags =
          0;

      result =
          device_->CreateQuery(
              &queryDescription,
              &completionQuery_);

      if (FAILED(result))
      {
        return result;
      }

      featureLevel_ =
          selectedFeatureLevel;

      return S_OK;
    }

    void resetD3DResources()
    {
      {
        std::lock_guard<std::mutex> stateLock(
            stateMutex_);

        stereoTextures_[0].Reset();
        stereoTextures_[1].Reset();

        activeTextureIndex_ =
            -1;

        pendingTextureIndex_ =
            -1;

        stereoTextureDescription_ = {};
      }

      completionQuery_.Reset();

      device1_.Reset();
      context_.Reset();
      device_.Reset();

      importedWidth_.store(
          0);

      importedHeight_.store(
          0);

      importedFormat_.store(
          0);

      submittedFrameCount_.store(
          0);

      presentedStereoPairCount_.store(
          0);

      presentedSubframeCount_.store(
          0);

      presentRateMilliHz_.store(
          0);

      featureLevel_ =
          D3D_FEATURE_LEVEL_9_1;
    }

    HRESULT validatePackedTexture(
        const D3D11_TEXTURE2D_DESC &description) const
    {
      if (
          description.Width !=
          kPackedWidth)
      {
        return E_INVALIDARG;
      }

      if (
          description.Height !=
          kPackedHeight)
      {
        return E_INVALIDARG;
      }

      /*
       * Electron currently exposes the shared frame as:
       *
       * DXGI_FORMAT_B8G8R8A8_UNORM = 87
       */
      if (
          description.Format !=
          DXGI_FORMAT_B8G8R8A8_UNORM)
      {
        return E_INVALIDARG;
      }

      if (
          description.SampleDesc.Count !=
          1)
      {
        return E_INVALIDARG;
      }

      return S_OK;
    }

    HRESULT ensureStereoTextures(
        const D3D11_TEXTURE2D_DESC &sourceDescription)
    {
      const bool compatible =
          stereoTextures_[0] &&
          stereoTextures_[1] &&
          stereoTextureDescription_.Width ==
              sourceDescription.Width &&
          stereoTextureDescription_.Height ==
              sourceDescription.Height &&
          stereoTextureDescription_.Format ==
              sourceDescription.Format &&
          stereoTextureDescription_.SampleDesc.Count ==
              sourceDescription.SampleDesc.Count;

      if (compatible)
      {
        return S_OK;
      }

      /*
       * The packed format is fixed for the Workbench.
       *
       * Reallocating while a presentation is active would require another
       * synchronization path, so a runtime format change is rejected.
       */
      if (
          stereoTextures_[0] ||
          stereoTextures_[1])
      {
        return E_INVALIDARG;
      }

      D3D11_TEXTURE2D_DESC description =
          sourceDescription;

      description.Usage =
          D3D11_USAGE_DEFAULT;

      description.CPUAccessFlags =
          0;

      description.MiscFlags =
          0;

      description.BindFlags =
          D3D11_BIND_SHADER_RESOURCE |
          D3D11_BIND_RENDER_TARGET;

      HRESULT result =
          device_->CreateTexture2D(
              &description,
              nullptr,
              &stereoTextures_[0]);

      if (FAILED(result))
      {
        return result;
      }

      result =
          device_->CreateTexture2D(
              &description,
              nullptr,
              &stereoTextures_[1]);

      if (FAILED(result))
      {
        stereoTextures_[0].Reset();

        return result;
      }

      stereoTextureDescription_ =
          description;

      return S_OK;
    }

    HRESULT waitForGpuCopy()
    {
      const auto deadline =
          std::chrono::steady_clock::now() +
          std::chrono::seconds(2);

      while (
          std::chrono::steady_clock::now() <
          deadline)
      {
        BOOL completed =
            FALSE;

        HRESULT result;

        /*
         * The D3D11 immediate context may only be called from one thread
         * at a time.
         */
        {
          std::lock_guard<std::mutex> contextLock(
              contextMutex_);

          result =
              context_->GetData(
                  completionQuery_.Get(),
                  &completed,
                  sizeof(completed),
                  0);
        }

        if (FAILED(result))
        {
          return result;
        }

        if (
            result == S_OK &&
            completed)
        {
          return S_OK;
        }

        std::this_thread::sleep_for(
            std::chrono::microseconds(100));
      }

      return HRESULT_FROM_WIN32(
          ERROR_TIMEOUT);
    }

    void signalPresentationInitialization(
        HRESULT result)
    {
      {
        std::lock_guard<std::mutex> initializationLock(
            initializationMutex_);

        presentationInitializationResult_ =
            result;

        presentationInitializationCompleted_ =
            true;
      }

      initializationCondition_.notify_one();
    }

    void presentationLoop()
    {
      HRESULT result =
          createOutputWindow();

      if (SUCCEEDED(result))
      {
        result =
            createSwapChain();
      }

      if (FAILED(result))
      {
        presentationError_.store(
            result);

        cleanupPresentationResources();

        signalPresentationInitialization(
            result);

        return;
      }

      signalPresentationInitialization(
          S_OK);

      auto rateStartTime =
          std::chrono::steady_clock::now();

      uint64_t rateStartSubframeCount =
          presentedSubframeCount_.load();

      while (
          !stopRequested_.load())
      {
        processWindowMessages();

        ComPtr<ID3D11Texture2D> stereoTexture =
            acquireTextureForNextPair();

        if (!stereoTexture)
        {
          std::this_thread::sleep_for(
              std::chrono::milliseconds(1));

          continue;
        }

        /*
         * One complete pair always uses the exact same private SBS texture.
         *
         * A new pending Three.js frame can only become active before the
         * next LEFT eye presentation.
         */
        result =
            presentEye(
                stereoTexture.Get(),
                0);

        if (
            result ==
            S_FALSE)
        {
          break;
        }

        if (FAILED(result))
        {
          presentationError_.store(
              result);

          break;
        }

        processWindowMessages();

        result =
            presentEye(
                stereoTexture.Get(),
                kOutputWidth);

        if (
            result ==
            S_FALSE)
        {
          break;
        }

        if (FAILED(result))
        {
          presentationError_.store(
              result);

          break;
        }

        presentedStereoPairCount_.fetch_add(
            1);

        updatePresentRate(
            rateStartTime,
            rateStartSubframeCount);
      }

      cleanupPresentationResources();
    }

    ComPtr<ID3D11Texture2D> acquireTextureForNextPair()
    {
      std::lock_guard<std::mutex> stateLock(
          stateMutex_);

      /*
       * Promote the newest complete frame only at a stereo pair boundary.
       */
      if (pendingTextureIndex_ >= 0)
      {
        activeTextureIndex_ =
            pendingTextureIndex_;

        pendingTextureIndex_ =
            -1;
      }

      if (activeTextureIndex_ < 0)
      {
        return nullptr;
      }

      /*
       * Taking a COM reference keeps this texture alive for both eye
       * presentations even after the state mutex is released.
       *
       * The submission thread will only write to the opposite slot.
       */
      return stereoTextures_[activeTextureIndex_];
    }

    HRESULT createOutputWindow()
    {
      const HINSTANCE instance =
          GetModuleHandleW(
              nullptr);

      WNDCLASSEXW windowClass = {};

      windowClass.cbSize =
          sizeof(windowClass);

      windowClass.style =
          CS_HREDRAW |
          CS_VREDRAW;

      windowClass.lpfnWndProc =
          outputWindowProcedure;

      windowClass.hInstance =
          instance;

      windowClass.hCursor =
          LoadCursorW(
              nullptr,
              IDC_ARROW);

      windowClass.hbrBackground =
          static_cast<HBRUSH>(
              GetStockObject(
                  BLACK_BRUSH));

      windowClass.lpszClassName =
          kWindowClassName;

      const ATOM classAtom =
          RegisterClassExW(
              &windowClass);

      if (classAtom == 0)
      {
        const DWORD error =
            GetLastError();

        if (
            error !=
            ERROR_CLASS_ALREADY_EXISTS)
        {
          return HRESULT_FROM_WIN32(
              error);
        }
      }

      /*
       * This output surface already matches the final Workbench desktop:
       *
       * 1400 x 2100
       *
       * +----------------------+
       * | UP                   |
       * | 1400 x 1050          |
       * +----------------------+
       * | DOWN                 |
       * | 1400 x 1050          |
       * +----------------------+
       */
      outputWindow_ =
          CreateWindowExW(
              0,
              kWindowClassName,
              kWindowTitle,
              WS_POPUP,
              0,
              0,
              static_cast<int>(
                  kOutputWidth),
              static_cast<int>(
                  kOutputHeight),
              nullptr,
              nullptr,
              instance,
              nullptr);

      if (!outputWindow_)
      {
        return HRESULT_FROM_WIN32(
            GetLastError());
      }

      ShowWindow(
          outputWindow_,
          SW_SHOWNOACTIVATE);

      UpdateWindow(
          outputWindow_);

      return S_OK;
    }

    HRESULT createSwapChain()
    {
      if (!outputWindow_)
      {
        return E_HANDLE;
      }

      ComPtr<IDXGIDevice1> dxgiDevice;

      HRESULT result =
          device_.As(
              &dxgiDevice);

      if (FAILED(result))
      {
        return result;
      }

      ComPtr<IDXGIAdapter> adapter;

      result =
          dxgiDevice->GetAdapter(
              &adapter);

      if (FAILED(result))
      {
        return result;
      }

      ComPtr<IDXGIFactory2> factory;

      result =
          adapter->GetParent(
              IID_PPV_ARGS(
                  &factory));

      if (FAILED(result))
      {
        return result;
      }

      /*
       * Disable the default DXGI Alt+Enter fullscreen behavior.
       */
      result =
          factory->MakeWindowAssociation(
              outputWindow_,
              DXGI_MWA_NO_ALT_ENTER);

      if (FAILED(result))
      {
        return result;
      }

      DXGI_SWAP_CHAIN_DESC1 description = {};

      description.Width =
          kOutputWidth;

      description.Height =
          kOutputHeight;

      description.Format =
          DXGI_FORMAT_B8G8R8A8_UNORM;

      description.Stereo =
          FALSE;

      description.SampleDesc.Count =
          1;

      description.SampleDesc.Quality =
          0;

      description.BufferUsage =
          DXGI_USAGE_RENDER_TARGET_OUTPUT;

      description.BufferCount =
          2;

      description.Scaling =
          DXGI_SCALING_STRETCH;

      description.SwapEffect =
          DXGI_SWAP_EFFECT_FLIP_DISCARD;

      description.AlphaMode =
          DXGI_ALPHA_MODE_IGNORE;

      /*
       * The waitable swap chain gives the native presenter an explicit
       * synchronization point for each physical presentation.
       */
      description.Flags =
          DXGI_SWAP_CHAIN_FLAG_FRAME_LATENCY_WAITABLE_OBJECT;

      result =
          factory->CreateSwapChainForHwnd(
              device_.Get(),
              outputWindow_,
              &description,
              nullptr,
              nullptr,
              &swapChain_);

      if (FAILED(result))
      {
        return result;
      }

      result =
          swapChain_.As(
              &swapChain2_);

      if (FAILED(result))
      {
        return result;
      }

      /*
       * Never allow DXGI to queue several future eye images.
       *
       * Stereo phase control requires a queue depth of one frame.
       */
      result =
          swapChain2_->SetMaximumFrameLatency(
              1);

      if (FAILED(result))
      {
        return result;
      }

      frameLatencyWaitableObject_ =
          swapChain2_->GetFrameLatencyWaitableObject();

      if (!frameLatencyWaitableObject_)
      {
        return E_FAIL;
      }

      return S_OK;
    }

    HRESULT presentEye(
        ID3D11Texture2D *stereoTexture,
        UINT sourceX)
    {
      if (
          !stereoTexture ||
          !swapChain_ ||
          !frameLatencyWaitableObject_)
      {
        return E_FAIL;
      }

      while (
          !stopRequested_.load())
      {
        const DWORD waitResult =
            WaitForSingleObjectEx(
                frameLatencyWaitableObject_,
                100,
                FALSE);

        if (
            waitResult ==
            WAIT_OBJECT_0)
        {
          break;
        }

        if (
            waitResult ==
            WAIT_TIMEOUT)
        {
          processWindowMessages();

          continue;
        }

        if (
            waitResult ==
            WAIT_FAILED)
        {
          return HRESULT_FROM_WIN32(
              GetLastError());
        }

        return E_FAIL;
      }

      if (
          stopRequested_.load())
      {
        return S_FALSE;
      }

      /*
       * DXGI and the D3D11 immediate context must not be used concurrently
       * from different threads.
       *
       * Keep GetBuffer(), CopySubresourceRegion() and Present() inside the
       * same critical section used by submitTexture().
       */
      std::lock_guard<std::mutex> contextLock(
          contextMutex_);

      ComPtr<ID3D11Texture2D> backBuffer;

      HRESULT result =
          swapChain_->GetBuffer(
              0,
              IID_PPV_ARGS(
                  &backBuffer));

      if (FAILED(result))
      {
        return result;
      }

      D3D11_BOX sourceBox = {};

      sourceBox.left =
          sourceX;

      sourceBox.top =
          0;

      sourceBox.front =
          0;

      sourceBox.right =
          sourceX +
          kOutputWidth;

      sourceBox.bottom =
          kOutputHeight;

      sourceBox.back =
          1;

      context_->CopySubresourceRegion(
          backBuffer.Get(),
          0,
          0,
          0,
          0,
          stereoTexture,
          0,
          &sourceBox);

      /*
       * Present on the next vertical blank.
       *
       * Present is intentionally executed while holding contextMutex_ so it
       * cannot overlap with CopyResource(), End(), Flush() or GetData() from
       * the Electron submission thread.
       */
      result =
          swapChain_->Present(
              1,
              0);

      if (FAILED(result))
      {
        return result;
      }

      presentedSubframeCount_.fetch_add(
          1);

      return S_OK;
    }

    void processWindowMessages()
    {
      MSG message = {};

      while (
          PeekMessageW(
              &message,
              nullptr,
              0,
              0,
              PM_REMOVE))
      {
        TranslateMessage(
            &message);

        DispatchMessageW(
            &message);
      }
    }

    void updatePresentRate(
        std::chrono::steady_clock::time_point &rateStartTime,
        uint64_t &rateStartSubframeCount)
    {
      const auto now =
          std::chrono::steady_clock::now();

      const double elapsedSeconds =
          std::chrono::duration<double>(
              now -
              rateStartTime)
              .count();

      if (
          elapsedSeconds <
          1.0)
      {
        return;
      }

      const uint64_t currentSubframeCount =
          presentedSubframeCount_.load();

      const uint64_t delta =
          currentSubframeCount -
          rateStartSubframeCount;

      const double rateHz =
          static_cast<double>(
              delta) /
          elapsedSeconds;

      presentRateMilliHz_.store(
          static_cast<uint64_t>(
              rateHz *
              1000.0));

      rateStartTime =
          now;

      rateStartSubframeCount =
          currentSubframeCount;
    }

    void cleanupPresentationResources()
    {
      if (frameLatencyWaitableObject_)
      {
        CloseHandle(
            frameLatencyWaitableObject_);

        frameLatencyWaitableObject_ =
            nullptr;
      }

      swapChain2_.Reset();
      swapChain_.Reset();

      if (outputWindow_)
      {
        DestroyWindow(
            outputWindow_);

        outputWindow_ =
            nullptr;
      }
    }

    std::mutex lifecycleMutex_;
    std::mutex submissionMutex_;
    std::mutex stateMutex_;
    std::mutex contextMutex_;

    std::mutex initializationMutex_;
    std::condition_variable initializationCondition_;

    bool presentationInitializationCompleted_ =
        false;

    HRESULT presentationInitializationResult_ =
        E_FAIL;

    std::thread presentationThread_;

    std::atomic<bool> initialized_{
        false};

    std::atomic<bool> stopRequested_{
        false};

    std::atomic<HRESULT> presentationError_{
        S_OK};

    ComPtr<ID3D11Device> device_;
    ComPtr<ID3D11Device1> device1_;
    ComPtr<ID3D11DeviceContext> context_;

    ComPtr<ID3D11Query> completionQuery_;

    std::array<
        ComPtr<ID3D11Texture2D>,
        2>
        stereoTextures_;

    D3D11_TEXTURE2D_DESC stereoTextureDescription_ = {};

    int activeTextureIndex_ =
        -1;

    int pendingTextureIndex_ =
        -1;

    ComPtr<IDXGISwapChain1> swapChain_;
    ComPtr<IDXGISwapChain2> swapChain2_;

    HANDLE frameLatencyWaitableObject_ =
        nullptr;

    HWND outputWindow_ =
        nullptr;

    D3D_FEATURE_LEVEL featureLevel_ =
        D3D_FEATURE_LEVEL_9_1;

    std::atomic<UINT> importedWidth_{
        0};

    std::atomic<UINT> importedHeight_{
        0};

    std::atomic<UINT> importedFormat_{
        0};

    std::atomic<uint64_t> submittedFrameCount_{
        0};

    std::atomic<uint64_t> presentedStereoPairCount_{
        0};

    std::atomic<uint64_t> presentedSubframeCount_{
        0};

    /*
     * Presentation frequency stored as millihertz to keep it atomic without
     * requiring a floating-point atomic type.
     */
    std::atomic<uint64_t> presentRateMilliHz_{
        0};
  };

  StereoPresenter presenter;

  Napi::Value initialize(
      const Napi::CallbackInfo &info)
  {
    Napi::Env env =
        info.Env();

    const HRESULT result =
        presenter.initialize();

    if (FAILED(result))
    {
      Napi::Error::New(
          env,
          "D3D11 initialization failed: " +
              formatHResult(result))
          .ThrowAsJavaScriptException();

      return env.Undefined();
    }

    Napi::Object output =
        Napi::Object::New(
            env);

    output.Set(
        "initialized",
        true);

    output.Set(
        "featureLevel",
        static_cast<uint32_t>(
            presenter.getFeatureLevel()));

    output.Set(
        "outputWidth",
        kOutputWidth);

    output.Set(
        "outputHeight",
        kOutputHeight);

    return output;
  }

  Napi::Value submitTexture(
      const Napi::CallbackInfo &info)
  {
    Napi::Env env =
        info.Env();

    if (
        info.Length() < 1 ||
        !info[0].IsObject())
    {
      Napi::TypeError::New(
          env,
          "submitTexture expects a textureInfo object.")
          .ThrowAsJavaScriptException();

      return env.Undefined();
    }

    Napi::Object textureInfo =
        info[0].As<Napi::Object>();

    if (!textureInfo.Has("handle"))
    {
      Napi::TypeError::New(
          env,
          "textureInfo.handle is missing.")
          .ThrowAsJavaScriptException();

      return env.Undefined();
    }

    Napi::Object handle =
        textureInfo
            .Get("handle")
            .As<Napi::Object>();

    if (!handle.Has("ntHandle"))
    {
      Napi::TypeError::New(
          env,
          "textureInfo.handle.ntHandle is missing.")
          .ThrowAsJavaScriptException();

      return env.Undefined();
    }

    Napi::Value ntHandleValue =
        handle.Get(
            "ntHandle");

    if (!ntHandleValue.IsBuffer())
    {
      Napi::TypeError::New(
          env,
          "textureInfo.handle.ntHandle must be a Buffer.")
          .ThrowAsJavaScriptException();

      return env.Undefined();
    }

    Napi::Buffer<uint8_t> handleBuffer =
        ntHandleValue.As<
            Napi::Buffer<uint8_t>>();

    if (
        handleBuffer.Length() <
        sizeof(HANDLE))
    {
      Napi::TypeError::New(
          env,
          "The NT handle buffer is too small.")
          .ThrowAsJavaScriptException();

      return env.Undefined();
    }

    HANDLE sharedHandle =
        nullptr;

    std::memcpy(
        &sharedHandle,
        handleBuffer.Data(),
        sizeof(HANDLE));

    D3D11_TEXTURE2D_DESC description = {};

    const HRESULT result =
        presenter.submit(
            sharedHandle,
            description);

    if (FAILED(result))
    {
      Napi::Error::New(
          env,
          "Shared texture presentation failed: " +
              formatHResult(result))
          .ThrowAsJavaScriptException();

      return env.Undefined();
    }

    Napi::Object output =
        Napi::Object::New(
            env);

    output.Set(
        "width",
        description.Width);

    output.Set(
        "height",
        description.Height);

    output.Set(
        "format",
        static_cast<uint32_t>(
            description.Format));

    /*
     * Keep the existing field name for compatibility with electron/main.js.
     */
    output.Set(
        "frameCount",
        static_cast<double>(
            presenter.getSubmittedFrameCount()));

    output.Set(
        "presentedStereoPairCount",
        static_cast<double>(
            presenter.getPresentedStereoPairCount()));

    output.Set(
        "presentedSubframeCount",
        static_cast<double>(
            presenter.getPresentedSubframeCount()));

    output.Set(
        "presentRateHz",
        presenter.getPresentRateHz());

    return output;
  }

  Napi::Value getStats(
      const Napi::CallbackInfo &info)
  {
    Napi::Env env =
        info.Env();

    Napi::Object output =
        Napi::Object::New(
            env);

    output.Set(
        "initialized",
        presenter.isInitialized());

    output.Set(
        "frameCount",
        static_cast<double>(
            presenter.getSubmittedFrameCount()));

    output.Set(
        "presentedStereoPairCount",
        static_cast<double>(
            presenter.getPresentedStereoPairCount()));

    output.Set(
        "presentedSubframeCount",
        static_cast<double>(
            presenter.getPresentedSubframeCount()));

    output.Set(
        "presentRateHz",
        presenter.getPresentRateHz());

    output.Set(
        "width",
        presenter.getWidth());

    output.Set(
        "height",
        presenter.getHeight());

    output.Set(
        "format",
        static_cast<uint32_t>(
            presenter.getFormat()));

    output.Set(
        "outputWidth",
        kOutputWidth);

    output.Set(
        "outputHeight",
        kOutputHeight);

    output.Set(
        "presentationError",
        static_cast<double>(
            static_cast<uint32_t>(
                presenter.getPresentationError())));

    return output;
  }

  Napi::Value shutdown(
      const Napi::CallbackInfo &info)
  {
    presenter.shutdown();

    return info.Env().Undefined();
  }

  Napi::Object initModule(
      Napi::Env env,
      Napi::Object exports)
  {
    exports.Set(
        "initialize",
        Napi::Function::New(
            env,
            initialize));

    exports.Set(
        "submitTexture",
        Napi::Function::New(
            env,
            submitTexture));

    exports.Set(
        "getStats",
        Napi::Function::New(
            env,
            getStats));

    exports.Set(
        "shutdown",
        Napi::Function::New(
            env,
            shutdown));

    AttachDiagnosticsExports(
        env,
        exports);

    return exports;
  }

  NODE_API_MODULE(
      stereo_presenter,
      initModule)

}