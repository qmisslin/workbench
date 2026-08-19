# Workbench

Electron + Three.js replacement for the legacy Unreal Engine / nDisplay Workbench setup.

The application renders a calibrated dual-display scene in Three.js and uses a native D3D11 backend for low-level presentation.

## Architecture

- Electron + Vite
- Three.js renderer
- Calibrated off-axis projection
- Offscreen Electron rendering with shared GPU textures
- Native N-API D3D11 presenter
- 2800×2100 packed stereo framebuffer
- Double-buffered native presentation thread
- DXGI / NVAPI stereo capability diagnostics
- Offline camera tracking debug pipeline
- OpenCV.js ArUco marker detection
- MediaPipe hand and pose tracking

The internal framebuffer layout is:

```text
+--------------------+--------------------+
| UP LEFT 1400x1050  | UP RIGHT 1400x1050 |
+--------------------+--------------------+
| DOWN LEFT          | DOWN RIGHT         |
| 1400x1050          | 1400x1050          |
+--------------------+--------------------+
````

The side-by-side layout is only used as an internal GPU transport format. It is never intended to be displayed directly on the physical Workbench screens.

## Stereo presentation

The renderer produces the complete left/right stereo pair in a single GPU texture.

Electron exposes the offscreen framebuffer as a shared GPU texture. The native D3D11 presenter imports that texture without CPU readback and maintains coherent stereo pairs using double-buffered owned D3D11 textures.

The native presentation thread presents:

```text
LEFT -> RIGHT -> LEFT -> RIGHT -> ...
```

A new renderer frame is promoted only at a stereo-pair boundary, ensuring that the left and right images of a pair always come from the same submitted framebuffer.

Physical active-stereo output still depends on the capabilities of the target Workbench GPU, driver and projectors.

## Tracking

Workbench contains an offline tracking debug pipeline using a single RGB camera.

The same camera stream is shared by:

* OpenCV.js for ArUco marker detection
* MediaPipe Hand Landmarker
* MediaPipe Pose Landmarker

The tracking debug window is separate from the stereo framebuffer and does not modify the current stereo projection.

Run it with:

```powershell
npm run tracking:debug
```

The debug view displays:

* Raw camera feed
* ArUco marker detection
* Marker ID and contour
* Hand landmarks
* Handedness and confidence
* Body pose landmarks
* Tracking backend status
* Processing timings

### ArUco

The current marker configuration uses:

```text
Dictionary: DICT_4X4_50
Marker ID: 0
```

OpenCV.js is built locally with the required ArUco bindings and stored as a precompiled runtime asset under:

```text
public/tracking/opencv/opencv.js
```

Docker and Emscripten are only required if this OpenCV.js artifact needs to be regenerated. They are not part of the normal Workbench build process.

### MediaPipe

MediaPipe runtime files and models are stored locally under:

```text
public/tracking/mediapipe
public/tracking/models
```

Tracking therefore does not require network access at runtime.

### Tracking coordinate systems

The tracking pipeline distinguishes between:

* 2D image landmarks
* MediaPipe local/world landmarks
* Camera-space marker pose
* Workbench-space metric coordinates

MediaPipe monocular depth is not treated as reliable absolute metric depth.

ArUco will eventually provide the metric head pose through camera calibration and `solvePnP`.

Tracking is deliberately not applied to the stereo cameras until the following calibration chain is valid:

```text
marker
  -> eyes
  -> camera
  -> Workbench
```

## Configuration

Workbench configuration is stored in:

```text
config/workbench.json
```

It contains the current screen geometry, stereo parameters and tracking configuration.

Tracking configuration includes:

* Camera resolution and frame rate
* OpenCV asset path
* ArUco dictionary and marker ID
* Physical marker size
* Camera intrinsics
* Camera distortion coefficients
* Camera-to-Workbench transform
* Marker-to-eye transform
* MediaPipe models and confidence thresholds

The camera-to-Workbench transform is currently considered uncalibrated, so tracking does not yet alter the stereo projection.

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
* Offline camera acquisition
* Offline OpenCV.js runtime
* ArUco marker detection
* Offline MediaPipe runtime
* Hand tracking
* Body pose tracking
* Independent tracking debug window

Not implemented or not validated yet:

* Physical active-stereo output on the target Workbench
* NVIDIA stereo / 3-pin DIN synchronization
* Camera intrinsic calibration
* Metric ArUco head pose configuration
* Camera-to-Workbench calibration
* Marker-to-eye calibration
* Head tracking applied to the stereo projection
* Runtime calibration tools
* Final external Three.js application loading workflow

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

Run the application:

```powershell
npm start
```

Run the tracking debug window:

```powershell
npm run tracking:debug
```

Run the offscreen/native presentation path:

```powershell
npm run offscreen
```

The normal development and packaging workflow does not require Docker.

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

Then install dependencies and rebuild the Electron native module:

```powershell
npm ci
npm run rebuild:native
```

## Runtime assets

Tracking runtime assets are versioned with the application:

```text
public/tracking/
├── opencv/
│   └── opencv.js
├── mediapipe/
│   └── wasm/
└── models/
```

These files are copied into the Vite build output and allow the tracking runtime to operate without downloading external resources.

The OpenCV source tree used to generate the custom `opencv.js` file is a temporary development dependency and is not part of the repository.

## Platform

Currently targeting:

* Windows
* x64
* Direct3D 11
* NVIDIA GPU