{
  "targets": [
    {
      "target_name": "stereo_presenter",
      "sources": [
        "src/stereo_presenter.cc",
        "src/nvapi_probe.cc",
        "src/diagnostics.cc"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "vendor/nvapi"
      ],
      "dependencies": [
        "<!(node -p \"require('node-addon-api').gyp\")"
      ],
      "defines": [
        "NAPI_DISABLE_CPP_EXCEPTIONS",
        "WIN32_LEAN_AND_MEAN",
        "NOMINMAX",
        "UNICODE",
        "_UNICODE"
      ],
      "libraries": [
        "d3d11.lib",
        "dxgi.lib",
        "user32.lib",
        "<(module_root_dir)/vendor/nvapi/amd64/nvapi64.lib"
      ],
      "msvs_settings": {
        "VCCLCompilerTool": {
          "AdditionalOptions": [
            "/std:c++17"
          ]
        }
      }
    }
  ]
}