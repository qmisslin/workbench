# Workbench

Electron + Three.js replacement for the legacy Unreal Engine / nDisplay Workbench setup.

The application renders a calibrated dual-display scene in Three.js and uses a native D3D11 backend for low-level presentation.

## Architecture

- Electron + Vite
- Three.js renderer
- Offscreen Electron rendering with shared GPU textures
- Native N-API D3D11 presenter
- 2800×2100 packed stereo framebuffer
- Double-buffered native presentation thread
- DXGI / NVAPI stereo capability diagnostics

The internal framebuffer layout is:

```text
+--------------------+--------------------+
| UP LEFT 1400x1050  | UP RIGHT 1400x1050 |
+--------------------+--------------------+
| DOWN LEFT          | DOWN RIGHT         |
| 1400x1050          | 1400x1050          |
+--------------------+--------------------+
```

The side-by-side layout is only used as an internal GPU transport format.

## Current status

Working:

* Calibrated off-axis projection for both physical screens
* Left/right eye rendering
* Electron shared GPU texture import into D3D11
* Native GPU-only texture copies
* Dedicated presentation thread
* Coherent left/right stereo pairs
* Stable VSync presentation
* NVAPI and DXGI stereo capability probing

Not implemented yet:

* Physical active-stereo output on the target Workbench
* NVIDIA stereo / 3-pin DIN synchronization
* Head tracking
* Runtime calibration tools

Physical stereo support must be validated on the actual Workbench hardware and driver configuration.

## Development

Install dependencies:

```powershell
npm ci
```

Rebuild the native Electron module:

```powershell
npm run rebuild:native
```

Run the offscreen/native presentation path:

```powershell
npm run offscreen
```

Run the application normally:

```powershell
npm start
```

## Native module

The native presenter is located in:

```text
native/stereo-presenter
```

NVAPI is included as a Git submodule under:

```text
native/stereo-presenter/vendor/nvapi
```

After cloning, initialize submodules with:

```powershell
git submodule update --init --recursive
```

## Platform

Currently targeting:

* Windows
* x64
* Direct3D 11
* NVIDIA GPU