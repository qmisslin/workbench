#pragma once

#include <Windows.h>
#include <d3d11.h>
#include <nvapi.h>

#include <string>

class NvapiStereoBackend {
public:
  void initializeBeforeDevice();

  void initializeAfterDevice(
    ID3D11Device* device
  );

  void shutdown();

  bool isNvapiInitialized() const;

  bool isDirectModePrepared() const;

  bool isDeviceHandleReady() const;

  const std::string& getGpuName() const;

  const std::string& getFallbackReason() const;

private:
  void setFallbackReason(
    const std::string& reason
  );

  bool nvapiInitialized_ =
    false;

  bool directModePrepared_ =
    false;

  bool deviceHandleReady_ =
    false;

  StereoHandle stereoHandle_ =
    nullptr;

  std::string gpuName_;

  std::string fallbackReason_;
};