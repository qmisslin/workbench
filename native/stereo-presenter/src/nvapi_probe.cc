#include "nvapi_probe.h"

#include <iostream>
#include <string>

namespace {

std::string getStatusText(
  NvAPI_Status status
) {
  NvAPI_ShortString message = {};

  const NvAPI_Status result =
    NvAPI_GetErrorMessage(
      status,
      message
    );

  if (result == NVAPI_OK) {
    return message;
  }

  return std::to_string(
    static_cast<int>(
      status
    )
  );
}

}

void NvapiStereoBackend::initializeBeforeDevice() {
  if (nvapiInitialized_) {
    return;
  }

  fallbackReason_.clear();
  gpuName_.clear();

  NvAPI_Status status =
    NvAPI_Initialize();

  std::cout
    << "NVAPI initialize: "
    << getStatusText(status)
    << std::endl;

  if (status != NVAPI_OK) {
    setFallbackReason(
      "NVAPI initialization failed: " +
      getStatusText(status)
    );

    return;
  }

  nvapiInitialized_ =
    true;

  NvAPI_ShortString interfaceVersion = {};

  status =
    NvAPI_GetInterfaceVersionString(
      interfaceVersion
    );

  if (status == NVAPI_OK) {
    std::cout
      << "NVAPI interface: "
      << interfaceVersion
      << std::endl;
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

  if (status == NVAPI_OK) {
    std::cout
      << "NVIDIA physical GPUs: "
      << gpuCount
      << std::endl;

    if (gpuCount > 0) {
      NvAPI_ShortString gpuName = {};

      const NvAPI_Status nameStatus =
        NvAPI_GPU_GetFullName(
          gpuHandles[0],
          gpuName
        );

      if (nameStatus == NVAPI_OK) {
        gpuName_ =
          gpuName;

        std::cout
          << "GPU 0: "
          << gpuName_
          << std::endl;
      }
    }
  }

  /*
   * Do not call NvAPI_Stereo_Enable().
   *
   * That function modifies the system-wide stereo registry state.
   * Workbench must use the stereo configuration already prepared on the
   * workstation.
   */
  NvU8 stereoEnabled =
    0;

  status =
    NvAPI_Stereo_IsEnabled(
      &stereoEnabled
    );

  if (status != NVAPI_OK) {
    setFallbackReason(
      "Stereo API unavailable: " +
      getStatusText(status)
    );

    return;
  }

  std::cout
    << "Stereo enabled: "
    << (
      stereoEnabled
        ? "yes"
        : "no"
    )
    << std::endl;

  if (!stereoEnabled) {
    setFallbackReason(
      "NVIDIA stereo is disabled in the system configuration."
    );

    return;
  }

  NvU8 windowedStereoSupported =
    0;

  status =
    NvAPI_Stereo_IsWindowedModeSupported(
      &windowedStereoSupported
    );

  if (status == NVAPI_OK) {
    std::cout
      << "Windowed stereo supported: "
      << (
        windowedStereoSupported
          ? "yes"
          : "no"
      )
      << std::endl;
  } else {
    std::cout
      << "Windowed stereo query: "
      << getStatusText(status)
      << std::endl;
  }

  /*
   * Direct mode must be selected before D3D11CreateDevice().
   */
  status =
    NvAPI_Stereo_SetDriverMode(
      NVAPI_STEREO_DRIVER_MODE_DIRECT
    );

  if (status != NVAPI_OK) {
    setFallbackReason(
      "Direct stereo mode unavailable: " +
      getStatusText(status)
    );

    return;
  }

  directModePrepared_ =
    true;

  std::cout
    << "NVAPI Direct stereo mode prepared"
    << std::endl;
}

void NvapiStereoBackend::initializeAfterDevice(
  ID3D11Device* device
) {
  if (
    !nvapiInitialized_ ||
    !directModePrepared_
  ) {
    return;
  }

  if (!device) {
    setFallbackReason(
      "Cannot create NVAPI stereo handle without a D3D11 device."
    );

    return;
  }

  NvAPI_Status status =
    NvAPI_Stereo_CreateHandleFromIUnknown(
      device,
      &stereoHandle_
    );

  if (status != NVAPI_OK) {
    stereoHandle_ =
      nullptr;

    setFallbackReason(
      "Stereo device handle creation failed: " +
      getStatusText(status)
    );

    return;
  }

  deviceHandleReady_ =
    true;

  /*
   * Do not activate stereo yet.
   *
   * The current presenter still owns a normal DXGI swap chain. Activation
   * will be introduced together with the NVAPI stereo swap chain so there
   * is no partially configured stereo path.
   */
  std::cout
    << "NVAPI stereo device handle ready"
    << std::endl;

  std::cout
    << "Stereo backend: NVAPI Direct ready, activation deferred"
    << std::endl;
}

void NvapiStereoBackend::shutdown() {
  if (
    nvapiInitialized_ &&
    stereoHandle_
  ) {
    const NvAPI_Status status =
      NvAPI_Stereo_DestroyHandle(
        stereoHandle_
      );

    std::cout
      << "NVAPI stereo handle destroy: "
      << getStatusText(status)
      << std::endl;

    stereoHandle_ =
      nullptr;
  }

  deviceHandleReady_ =
    false;

  directModePrepared_ =
    false;

  if (nvapiInitialized_) {
    const NvAPI_Status status =
      NvAPI_Unload();

    std::cout
      << "NVAPI unload: "
      << getStatusText(status)
      << std::endl;
  }

  nvapiInitialized_ =
    false;
}

bool NvapiStereoBackend::isNvapiInitialized() const {
  return nvapiInitialized_;
}

bool NvapiStereoBackend::isDirectModePrepared() const {
  return directModePrepared_;
}

bool NvapiStereoBackend::isDeviceHandleReady() const {
  return deviceHandleReady_;
}

const std::string&
NvapiStereoBackend::getGpuName() const {
  return gpuName_;
}

const std::string&
NvapiStereoBackend::getFallbackReason() const {
  return fallbackReason_;
}

void NvapiStereoBackend::setFallbackReason(
  const std::string& reason
) {
  fallbackReason_ =
    reason;

  directModePrepared_ =
    false;

  deviceHandleReady_ =
    false;

  std::cout
    << "NVAPI stereo fallback: "
    << fallbackReason_
    << std::endl;

  std::cout
    << "Stereo backend: DXGI frame-sequential fallback"
    << std::endl;
}