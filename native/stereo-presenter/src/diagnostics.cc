#include "diagnostics.h"

#include <Windows.h>
#include <dxgi1_3.h>
#include <wrl/client.h>

#include <nvapi.h>

#include <cstdint>
#include <sstream>
#include <string>
#include <vector>

using Microsoft::WRL::ComPtr;

namespace
{

std::string formatHResult(
  HRESULT result
)
{
  std::ostringstream stream;

  stream
    << "0x"
    << std::hex
    << std::uppercase
    << static_cast<uint32_t>(
      result
    );

  return stream.str();
}

std::string getNvapiStatusText(
  NvAPI_Status status
)
{
  NvAPI_ShortString message = {};

  const NvAPI_Status result =
    NvAPI_GetErrorMessage(
      status,
      message
    );

  if (result == NVAPI_OK)
  {
    return message;
  }

  return std::to_string(
    static_cast<int>(
      status
    )
  );
}

std::string wideToUtf8(
  const wchar_t* value
)
{
  if (!value)
  {
    return {};
  }

  const int length =
    lstrlenW(
      value
    );

  if (length <= 0)
  {
    return {};
  }

  const int requiredLength =
    WideCharToMultiByte(
      CP_UTF8,
      0,
      value,
      length,
      nullptr,
      0,
      nullptr,
      nullptr
    );

  if (requiredLength <= 0)
  {
    return {};
  }

  std::string result(
    static_cast<size_t>(
      requiredLength
    ),
    '\0'
  );

  WideCharToMultiByte(
    CP_UTF8,
    0,
    value,
    length,
    result.data(),
    requiredLength,
    nullptr,
    nullptr
  );

  return result;
}

double getRefreshRateHz(
  const DXGI_RATIONAL& refreshRate
)
{
  if (
    refreshRate.Denominator ==
    0
  )
  {
    return 0.0;
  }

  return
    static_cast<double>(
      refreshRate.Numerator
    ) /
    static_cast<double>(
      refreshRate.Denominator
    );
}

Napi::Object createNvapiDiagnostics(
  Napi::Env env
)
{
  Napi::Object diagnostics =
    Napi::Object::New(
      env
    );

  NvAPI_ShortString interfaceVersion = {};

  NvAPI_Status status =
    NvAPI_GetInterfaceVersionString(
      interfaceVersion
    );

  diagnostics.Set(
    "interfaceStatus",
    getNvapiStatusText(
      status
    )
  );

  if (status == NVAPI_OK)
  {
    diagnostics.Set(
      "interfaceVersion",
      interfaceVersion
    );
  }

  NvPhysicalGpuHandle gpuHandles[
    NVAPI_MAX_PHYSICAL_GPUS
  ] = {};

  NvU32 gpuCount =
    0;

  status =
    NvAPI_EnumPhysicalGPUs(
      gpuHandles,
      &gpuCount
    );

  diagnostics.Set(
    "gpuEnumerationStatus",
    getNvapiStatusText(
      status
    )
  );

  Napi::Array gpuNames =
    Napi::Array::New(
      env
    );

  if (status == NVAPI_OK)
  {
    uint32_t resultIndex =
      0;

    for (
      NvU32 index = 0;
      index < gpuCount;
      ++index
    )
    {
      NvAPI_ShortString gpuName = {};

      const NvAPI_Status nameStatus =
        NvAPI_GPU_GetFullName(
          gpuHandles[index],
          gpuName
        );

      if (nameStatus != NVAPI_OK)
      {
        continue;
      }

      gpuNames.Set(
        resultIndex,
        Napi::String::New(
          env,
          gpuName
        )
      );

      resultIndex++;
    }
  }

  diagnostics.Set(
    "gpus",
    gpuNames
  );

  NvU8 stereoEnabled =
    0;

  status =
    NvAPI_Stereo_IsEnabled(
      &stereoEnabled
    );

  diagnostics.Set(
    "stereoEnabledStatus",
    getNvapiStatusText(
      status
    )
  );

  if (status == NVAPI_OK)
  {
    diagnostics.Set(
      "stereoEnabled",
      stereoEnabled != 0
    );
  }

  NvU8 windowedStereoSupported =
    0;

  status =
    NvAPI_Stereo_IsWindowedModeSupported(
      &windowedStereoSupported
    );

  diagnostics.Set(
    "windowedStereoSupportedStatus",
    getNvapiStatusText(
      status
    )
  );

  if (status == NVAPI_OK)
  {
    diagnostics.Set(
      "windowedStereoSupported",
      windowedStereoSupported != 0
    );
  }

  return diagnostics;
}

Napi::Object createDxgiDiagnostics(
  Napi::Env env
)
{
  Napi::Object diagnostics =
    Napi::Object::New(
      env
    );

  ComPtr<IDXGIFactory1> factory1;

  HRESULT result =
    CreateDXGIFactory1(
      IID_PPV_ARGS(
        &factory1
      )
    );

  diagnostics.Set(
    "factoryStatus",
    formatHResult(
      result
    )
  );

  Napi::Array outputs =
    Napi::Array::New(
      env
    );

  if (FAILED(result))
  {
    diagnostics.Set(
      "outputs",
      outputs
    );

    diagnostics.Set(
      "outputCount",
      0
    );

    return diagnostics;
  }

  ComPtr<IDXGIFactory2> factory2;

  result =
    factory1.As(
      &factory2
    );

  diagnostics.Set(
    "factory2Status",
    formatHResult(
      result
    )
  );

  if (SUCCEEDED(result))
  {
    diagnostics.Set(
      "windowedStereoEnabled",
      factory2->IsWindowedStereoEnabled() != FALSE
    );
  }

  uint32_t globalOutputIndex =
    0;

  for (
    UINT adapterIndex = 0;
    ;
    ++adapterIndex
  )
  {
    ComPtr<IDXGIAdapter1> adapter;

    result =
      factory1->EnumAdapters1(
        adapterIndex,
        &adapter
      );

    if (
      result ==
      DXGI_ERROR_NOT_FOUND
    )
    {
      break;
    }

    if (FAILED(result))
    {
      break;
    }

    DXGI_ADAPTER_DESC1 adapterDescription = {};

    const HRESULT adapterDescriptionResult =
      adapter->GetDesc1(
        &adapterDescription
      );

    std::string adapterName;

    if (SUCCEEDED(adapterDescriptionResult))
    {
      adapterName =
        wideToUtf8(
          adapterDescription.Description
        );
    }

    for (
      UINT outputIndex = 0;
      ;
      ++outputIndex
    )
    {
      ComPtr<IDXGIOutput> output;

      result =
        adapter->EnumOutputs(
          outputIndex,
          &output
        );

      if (
        result ==
        DXGI_ERROR_NOT_FOUND
      )
      {
        break;
      }

      if (FAILED(result))
      {
        break;
      }

      Napi::Object outputDiagnostics =
        Napi::Object::New(
          env
        );

      outputDiagnostics.Set(
        "index",
        globalOutputIndex
      );

      outputDiagnostics.Set(
        "adapterIndex",
        adapterIndex
      );

      outputDiagnostics.Set(
        "adapterName",
        adapterName
      );

      DXGI_OUTPUT_DESC description = {};

      result =
        output->GetDesc(
          &description
        );

      if (SUCCEEDED(result))
      {
        outputDiagnostics.Set(
          "deviceName",
          wideToUtf8(
            description.DeviceName
          )
        );

        outputDiagnostics.Set(
          "attachedToDesktop",
          description.AttachedToDesktop != FALSE
        );

        outputDiagnostics.Set(
          "left",
          description.DesktopCoordinates.left
        );

        outputDiagnostics.Set(
          "top",
          description.DesktopCoordinates.top
        );

        outputDiagnostics.Set(
          "right",
          description.DesktopCoordinates.right
        );

        outputDiagnostics.Set(
          "bottom",
          description.DesktopCoordinates.bottom
        );

        const LONG desktopWidth =
          description.DesktopCoordinates.right -
          description.DesktopCoordinates.left;

        const LONG desktopHeight =
          description.DesktopCoordinates.bottom -
          description.DesktopCoordinates.top;

        outputDiagnostics.Set(
          "currentWidth",
          desktopWidth
        );

        outputDiagnostics.Set(
          "currentHeight",
          desktopHeight
        );

        DEVMODEW currentMode = {};

        currentMode.dmSize =
          sizeof(
            currentMode
          );

        const BOOL currentModeAvailable =
          EnumDisplaySettingsW(
            description.DeviceName,
            ENUM_CURRENT_SETTINGS,
            &currentMode
          );

        if (currentModeAvailable)
        {
          outputDiagnostics.Set(
            "currentWidth",
            currentMode.dmPelsWidth
          );

          outputDiagnostics.Set(
            "currentHeight",
            currentMode.dmPelsHeight
          );

          if (
            currentMode.dmDisplayFrequency >
            1
          )
          {
            outputDiagnostics.Set(
              "currentRefreshHz",
              static_cast<double>(
                currentMode.dmDisplayFrequency
              )
            );
          }
        }
      }

      Napi::Array stereoModes =
        Napi::Array::New(
          env
        );

      uint32_t stereoModeCount =
        0;

      ComPtr<IDXGIOutput1> output1;

      HRESULT stereoResult =
        output.As(
          &output1
        );

      if (SUCCEEDED(stereoResult))
      {
        UINT modeCount =
          0;

        stereoResult =
          output1->GetDisplayModeList1(
            DXGI_FORMAT_B8G8R8A8_UNORM,
            DXGI_ENUM_MODES_STEREO,
            &modeCount,
            nullptr
          );

        if (
          SUCCEEDED(stereoResult) &&
          modeCount > 0
        )
        {
          std::vector<DXGI_MODE_DESC1> modes(
            modeCount
          );

          stereoResult =
            output1->GetDisplayModeList1(
              DXGI_FORMAT_B8G8R8A8_UNORM,
              DXGI_ENUM_MODES_STEREO,
              &modeCount,
              modes.data()
            );

          if (SUCCEEDED(stereoResult))
          {
            for (
              UINT modeIndex = 0;
              modeIndex < modeCount;
              ++modeIndex
            )
            {
              const DXGI_MODE_DESC1& mode =
                modes[modeIndex];

              if (!mode.Stereo)
              {
                continue;
              }

              Napi::Object modeDiagnostics =
                Napi::Object::New(
                  env
                );

              modeDiagnostics.Set(
                "width",
                mode.Width
              );

              modeDiagnostics.Set(
                "height",
                mode.Height
              );

              modeDiagnostics.Set(
                "refreshHz",
                getRefreshRateHz(
                  mode.RefreshRate
                )
              );

              stereoModes.Set(
                stereoModeCount,
                modeDiagnostics
              );

              stereoModeCount++;
            }
          }
        }
      }

      outputDiagnostics.Set(
        "stereoQueryStatus",
        formatHResult(
          stereoResult
        )
      );

      outputDiagnostics.Set(
        "stereoModeCount",
        stereoModeCount
      );

      outputDiagnostics.Set(
        "stereoModes",
        stereoModes
      );

      outputs.Set(
        globalOutputIndex,
        outputDiagnostics
      );

      globalOutputIndex++;
    }
  }

  diagnostics.Set(
    "outputs",
    outputs
  );

  diagnostics.Set(
    "outputCount",
    globalOutputIndex
  );

  return diagnostics;
}

Napi::Value getSystemDiagnostics(
  const Napi::CallbackInfo& info
)
{
  Napi::Env env =
    info.Env();

  Napi::Object diagnostics =
    Napi::Object::New(
      env
    );

  diagnostics.Set(
    "nvapi",
    createNvapiDiagnostics(
      env
    )
  );

  diagnostics.Set(
    "dxgi",
    createDxgiDiagnostics(
      env
    )
  );

  return diagnostics;
}

}

void AttachDiagnosticsExports(
  Napi::Env env,
  Napi::Object exports
)
{
  exports.Set(
    "getSystemDiagnostics",
    Napi::Function::New(
      env,
      getSystemDiagnostics
    )
  );
}