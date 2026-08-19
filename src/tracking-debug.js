import {
    DrawingUtils,
    FilesetResolver,
    HandLandmarker,
    PoseLandmarker
} from '@mediapipe/tasks-vision';

import './tracking-debug.css';

const video =
    document.getElementById(
        'camera-video'
    );

const overlay =
    document.getElementById(
        'tracking-overlay'
    );

const overlayContext =
    overlay.getContext('2d');

const drawingUtils =
    new DrawingUtils(
        overlayContext
    );

const statusElements = {
    camera: document.getElementById(
        'status-camera'
    ),
    opencv: document.getElementById(
        'status-opencv'
    ),
    aruco: document.getElementById(
        'status-aruco'
    ),
    mediapipe: document.getElementById(
        'status-mediapipe'
    ),
    hands: document.getElementById(
        'status-hands'
    ),
    pose: document.getElementById(
        'status-pose'
    ),
    loop: document.getElementById(
        'status-loop'
    )
};

const cameraInfoElement =
    document.getElementById(
        'camera-info'
    );

const markerInfoElement =
    document.getElementById(
        'marker-info'
    );

const handsInfoElement =
    document.getElementById(
        'hands-info'
    );

const bodyInfoElement =
    document.getElementById(
        'body-info'
    );

const timingsInfoElement =
    document.getElementById(
        'timings-info'
    );

const trackingStateJsonElement =
    document.getElementById(
        'tracking-state-json'
    );

const DICTIONARY_IDS = {
    DICT_4X4_50: 0,
    DICT_4X4_100: 1,
    DICT_4X4_250: 2,
    DICT_4X4_1000: 3,
    DICT_5X5_50: 4,
    DICT_5X5_100: 5,
    DICT_5X5_250: 6,
    DICT_5X5_1000: 7,
    DICT_6X6_50: 8,
    DICT_6X6_100: 9,
    DICT_6X6_250: 10,
    DICT_6X6_1000: 11,
    DICT_7X7_50: 12,
    DICT_7X7_100: 13,
    DICT_7X7_250: 14,
    DICT_7X7_1000: 15,
    DICT_ARUCO_ORIGINAL: 16,
    DICT_APRILTAG_16h5: 17,
    DICT_APRILTAG_25h9: 18,
    DICT_APRILTAG_36h10: 19,
    DICT_APRILTAG_36h11: 20,
    DICT_ARUCO_MIP_36h12: 21
};

const INITIALIZATION_TIMEOUT_MS =
    20000;

const localObjectUrls =
    new Set();

let config =
    null;

let cameraStream =
    null;

let cameraTrack =
    null;

let openCvContext =
    null;

let handLandmarker =
    null;

let poseLandmarker =
    null;

let latestRawHandResult =
    null;

let latestRawPoseResult =
    null;

let latestMarkerDebug = {
    detections: [],
    selected: null
};

let processing =
    false;

let lastProcessingTimestampMs =
    -Infinity;

let lastStateJsonUpdateMs =
    -Infinity;

let sequence =
    0;

function createEmptyHandState() {
    return {
        tracked: false,
        handedness: null,
        handednessConfidence: null,
        imageLandmarks: [],
        worldLandmarks: [],
        workbenchLandmarks: null
    };
}

const trackingState = {
    timestampMs: 0,
    sequence: 0,

    backends: {
        camera: {
            status: 'loading',
            message: null
        },
        opencv: {
            status: 'idle',
            message: null
        },
        aruco: {
            status: 'idle',
            message: null
        },
        mediapipe: {
            status: 'idle',
            message: null
        },
        hands: {
            status: 'idle',
            message: null
        },
        pose: {
            status: 'idle',
            message: null
        },
        loop: {
            status: 'idle',
            message: null
        }
    },

    camera: {
        deviceLabel: null,
        widthPx: 0,
        heightPx: 0,
        frameRateHz: null
    },

    marker: {
        tracked: false,
        selectedId: null,
        detections: [],
        poseCamera: null
    },

    viewer: {
        tracked: false,
        calibrated: false,
        transform: null,
        leftEye: null,
        rightEye: null
    },

    hands: {
        left: createEmptyHandState(),
        right: createEmptyHandState(),
        unassigned: []
    },

    body: {
        tracked: false,
        imageLandmarks: [],
        worldLandmarks: [],
        workbenchLandmarks: null
    },

    timings: {
        opencvMs: null,
        handsMs: null,
        poseMs: null,
        totalMs: null
    }
};

function setBackendStatus(
    backend,
    status,
    message = null
) {
    trackingState.backends[backend] = {
        status,
        message
    };

    const element =
        statusElements[backend];

    if (element) {
        element.textContent =
            message
                ? `${status}: ${message}`
                : status;

        element.className =
            `status-${status}`;
    }

    publishTrackingState();
}

function publishTrackingState() {
    trackingState.timestampMs =
        performance.timeOrigin +
        performance.now();

    trackingState.sequence =
        sequence;

    window.trackingBridge
        ?.publishTrackingState(
            trackingState
        );
}

function getErrorMessage(error) {
    if (error instanceof Error) {
        return error.message;
    }

    return String(error);
}

function withTimeout(
    promise,
    timeoutMs,
    label
) {
    let timeoutHandle =
        null;

    const timeoutPromise =
        new Promise(
            (
                _resolve,
                reject
            ) => {
                timeoutHandle =
                    setTimeout(
                        () => {
                            reject(
                                new Error(
                                    `${label} timed out after ${timeoutMs} ms.`
                                )
                            );
                        },
                        timeoutMs
                    );
            }
        );

    return Promise.race([
        promise,
        timeoutPromise
    ]).finally(
        () => {
            clearTimeout(
                timeoutHandle
            );
        }
    );
}

function createObjectUrl(
    data,
    mimeType
) {
    const url =
        URL.createObjectURL(
            new Blob(
                [data],
                {
                    type:
                        mimeType
                }
            )
        );

    localObjectUrls.add(
        url
    );

    return url;
}

function normalizeBinaryAsset(
    asset
) {
    if (
        asset instanceof
        Uint8Array
    ) {
        return asset;
    }

    if (
        asset instanceof
        ArrayBuffer
    ) {
        return new Uint8Array(
            asset
        );
    }

    if (
        ArrayBuffer.isView(
            asset
        )
    ) {
        return new Uint8Array(
            asset.buffer,
            asset.byteOffset,
            asset.byteLength
        );
    }

    throw new TypeError(
        'Unsupported binary tracking asset.'
    );
}

async function loadLocalScript(
    assetPath
) {
    const source =
        await window.trackingBridge
            .readTextAsset(
                assetPath
            );

    const scriptUrl =
        createObjectUrl(
            source,
            'text/javascript'
        );

    await new Promise(
        (
            resolve,
            reject
        ) => {
            const script =
                document.createElement(
                    'script'
                );

            script.src =
                scriptUrl;

            script.async =
                true;

            script.addEventListener(
                'load',
                resolve,
                {
                    once: true
                }
            );

            script.addEventListener(
                'error',
                () => {
                    reject(
                        new Error(
                            `Failed to execute local script ${assetPath}.`
                        )
                    );
                },
                {
                    once: true
                }
            );

            document.head.appendChild(
                script
            );
        }
    );
}

function isFiniteNumber(value) {
    return (
        typeof value === 'number' &&
        Number.isFinite(value)
    );
}

function formatNumber(
    value,
    digits = 3
) {
    if (!isFiniteNumber(value)) {
        return 'n/a';
    }

    return value.toFixed(
        digits
    );
}

function cloneLandmarks(
    landmarks
) {
    if (!Array.isArray(landmarks)) {
        return [];
    }

    return landmarks.map(
        (landmark) => ({
            x: landmark.x,
            y: landmark.y,
            z: landmark.z,
            visibility:
                landmark.visibility ?? null,
            presence:
                landmark.presence ?? null
        })
    );
}

function getHandCategory(
    handResult,
    index
) {
    const collections =
        handResult?.handedness ||
        handResult?.handednesses ||
        [];

    const categories =
        collections[index] ||
        [];

    return categories[0] ||
        null;
}

function normalizeHandednessLabel(
    label
) {
    if (
        typeof label !==
        'string'
    ) {
        return null;
    }

    const normalized =
        label.toLowerCase();

    if (normalized === 'left') {
        return config.tracking.mediapipe.swapHandedness
            ? 'right'
            : 'left';
    }

    if (normalized === 'right') {
        return config.tracking.mediapipe.swapHandedness
            ? 'left'
            : 'right';
    }

    return normalized;
}

function createHandState(
    handResult,
    index
) {
    const category =
        getHandCategory(
            handResult,
            index
        );

    const rawLabel =
        category?.categoryName ||
        category?.displayName ||
        null;

    const handedness =
        normalizeHandednessLabel(
            rawLabel
        );

    return {
        tracked: true,
        handedness,
        handednessConfidence:
            isFiniteNumber(
                category?.score
            )
                ? category.score
                : null,
        imageLandmarks:
            cloneLandmarks(
                handResult.landmarks?.[
                index
                ]
            ),
        worldLandmarks:
            cloneLandmarks(
                handResult.worldLandmarks?.[
                index
                ]
            ),
        workbenchLandmarks:
            null
    };
}

function updateHandsState(
    handResult
) {
    const landmarks =
        handResult?.landmarks ||
        [];

    const nextHands = {
        left:
            createEmptyHandState(),
        right:
            createEmptyHandState(),
        unassigned: []
    };

    for (
        let index = 0;
        index < landmarks.length;
        ++index
    ) {
        const hand =
            createHandState(
                handResult,
                index
            );

        if (
            hand.handedness === 'left' ||
            hand.handedness === 'right'
        ) {
            const current =
                nextHands[
                hand.handedness
                ];

            if (
                !current.tracked ||
                (
                    hand.handednessConfidence ??
                    0
                ) >
                (
                    current.handednessConfidence ??
                    0
                )
            ) {
                if (current.tracked) {
                    nextHands.unassigned.push(
                        current
                    );
                }

                nextHands[
                    hand.handedness
                ] =
                    hand;
            } else {
                nextHands.unassigned.push(
                    hand
                );
            }
        } else {
            nextHands.unassigned.push(
                hand
            );
        }
    }

    trackingState.hands =
        nextHands;
}

function updateBodyState(
    poseResult
) {
    const imageLandmarks =
        poseResult?.landmarks?.[0] ||
        [];

    const worldLandmarks =
        poseResult?.worldLandmarks?.[
        0
        ] ||
        [];

    trackingState.body = {
        tracked:
            imageLandmarks.length >
            0,
        imageLandmarks:
            cloneLandmarks(
                imageLandmarks
            ),
        worldLandmarks:
            cloneLandmarks(
                worldLandmarks
            ),
        workbenchLandmarks:
            null
    };
}

function updateMarkerState(
    markerDebug
) {
    latestMarkerDebug =
        markerDebug;

    const selected =
        markerDebug.selected;

    trackingState.marker = {
        tracked:
            Boolean(selected),
        selectedId:
            selected?.id ?? null,
        detections:
            markerDebug.detections.map(
                (detection) => ({
                    id:
                        detection.id,
                    confidence:
                        null,
                    corners:
                        detection.corners
                })
            ),
        poseCamera:
            selected?.poseCamera ||
            null
    };

    /*
     * The tracking state is intentionally not connected to the stereo
     * projection yet.
     *
     * Until camera -> Workbench and marker -> eye calibration is valid,
     * the renderer continues using WORKBENCH_CONFIG.head.positionM.
     */
    trackingState.viewer = {
        tracked:
            Boolean(selected),
        calibrated:
            false,
        transform:
            null,
        leftEye:
            null,
        rightEye:
            null
    };
}

async function openCamera() {
    setBackendStatus(
        'camera',
        'loading'
    );

    const cameraConfig =
        config.tracking.camera;

    const videoConstraints = {
        width: {
            ideal:
                cameraConfig.widthPx
        },
        height: {
            ideal:
                cameraConfig.heightPx
        },
        frameRate: {
            ideal:
                cameraConfig.frameRateHz
        }
    };

    if (cameraConfig.deviceId) {
        videoConstraints.deviceId = {
            exact:
                cameraConfig.deviceId
        };
    }

    cameraStream =
        await navigator.mediaDevices
            .getUserMedia({
                audio: false,
                video:
                    videoConstraints
            });

    video.srcObject =
        cameraStream;

    await new Promise(
        (resolve) => {
            if (
                video.readyState >=
                HTMLMediaElement
                    .HAVE_METADATA
            ) {
                resolve();

                return;
            }

            video.addEventListener(
                'loadedmetadata',
                resolve,
                {
                    once: true
                }
            );
        }
    );

    await video.play();

    video.width =
        video.videoWidth;

    video.height =
        video.videoHeight;

    cameraTrack =
        cameraStream
            .getVideoTracks()[0] ||
        null;

    const settings =
        cameraTrack
            ?.getSettings() ||
        {};

    overlay.width =
        video.videoWidth;

    overlay.height =
        video.videoHeight;

    trackingState.camera = {
        deviceLabel:
            cameraTrack?.label ||
            null,
        widthPx:
            video.videoWidth,
        heightPx:
            video.videoHeight,
        frameRateHz:
            isFiniteNumber(
                settings.frameRate
            )
                ? settings.frameRate
                : null
    };

    setBackendStatus(
        'camera',
        'ready'
    );
}

async function resolveOpenCvRuntime() {
    const deadline =
        performance.now() +
        INITIALIZATION_TIMEOUT_MS;

    while (
        performance.now() <
        deadline
    ) {
        let candidate =
            window.cv;

        if (
            candidate &&
            typeof candidate.then ===
            'function'
        ) {
            candidate =
                await candidate;
        }

        if (
            candidate &&
            typeof candidate.Mat ===
            'function'
        ) {
            return candidate;
        }

        await new Promise(
            (resolve) => {
                setTimeout(
                    resolve,
                    50
                );
            }
        );
    }

    throw new Error(
        'OpenCV.js runtime initialization timed out.'
    );
}

function getOpenCvClass(
    cv,
    names
) {
    for (
        const name of names
    ) {
        if (
            typeof cv[name] ===
            'function'
        ) {
            return cv[name];
        }
    }

    return null;
}

function createArucoDetector(cv) {
    const dictionaryName =
        config.tracking.opencv.dictionary;

    const dictionaryId =
        DICTIONARY_IDS[
        dictionaryName
        ];

    if (
        dictionaryId ===
        undefined
    ) {
        throw new Error(
            `Unsupported dictionary: ${dictionaryName}`
        );
    }

    if (
        typeof cv.getPredefinedDictionary !==
        'function'
    ) {
        throw new Error(
            'OpenCV.js does not expose getPredefinedDictionary().'
        );
    }

    const ArucoDetector =
        getOpenCvClass(
            cv,
            [
                'ArucoDetector',
                'aruco_ArucoDetector'
            ]
        );

    const DetectorParameters =
        getOpenCvClass(
            cv,
            [
                'DetectorParameters',
                'aruco_DetectorParameters'
            ]
        );

    const RefineParameters =
        getOpenCvClass(
            cv,
            [
                'RefineParameters',
                'aruco_RefineParameters'
            ]
        );

    if (!ArucoDetector) {
        throw new Error(
            'OpenCV.js does not expose ArucoDetector.'
        );
    }

    if (!DetectorParameters) {
        throw new Error(
            'OpenCV.js does not expose DetectorParameters.'
        );
    }

    if (!RefineParameters) {
        throw new Error(
            'OpenCV.js does not expose RefineParameters.'
        );
    }

    const dictionary =
        cv.getPredefinedDictionary(
            dictionaryId
        );

    const detectorParameters =
        new DetectorParameters();

    /*
     * The generated Embind constructor requires the three C++ parameters
     * explicitly, even though OpenCV declares defaults in C++.
     *
     * These values are the OpenCV defaults for RefineParameters.
     */
    const refineParameters =
        new RefineParameters(
            10.0,
            3.0,
            true
        );

    let detector;

    try {
        detector =
            new ArucoDetector(
                dictionary,
                detectorParameters,
                refineParameters
            );
    } finally {
        /*
         * ArucoDetector owns its internal parameter state after construction.
         * The temporary Embind wrapper is no longer required.
         */
        refineParameters.delete();
    }

    return {
        dictionary,
        detectorParameters,
        detector
    };
}

async function initializeOpenCv() {
    setBackendStatus(
        'opencv',
        'loading',
        'reading local asset'
    );

    setBackendStatus(
        'aruco',
        'loading'
    );

    try {
        await withTimeout(
            loadLocalScript(
                config.tracking.opencv
                    .assetPath
            ),
            INITIALIZATION_TIMEOUT_MS,
            'OpenCV local script'
        );

        setBackendStatus(
            'opencv',
            'loading',
            'initializing runtime'
        );

        const cv =
            await resolveOpenCvRuntime();

        setBackendStatus(
            'opencv',
            'ready'
        );

        try {
            const aruco =
                createArucoDetector(
                    cv
                );

            if (
                typeof cv.VideoCapture !==
                'function'
            ) {
                throw new Error(
                    'OpenCV.js does not expose VideoCapture.'
                );
            }

            const capture =
                new cv.VideoCapture(
                    video
                );

            const frameRgba =
                new cv.Mat(
                    video.videoHeight,
                    video.videoWidth,
                    cv.CV_8UC4
                );

            const frameGray =
                new cv.Mat(
                    video.videoHeight,
                    video.videoWidth,
                    cv.CV_8UC1
                );

            openCvContext = {
                cv,
                ...aruco,
                capture,
                frameRgba,
                frameGray
            };

            setBackendStatus(
                'aruco',
                'ready',
                hasValidMarkerPoseConfiguration()
                    ? null
                    : 'detection only; pose calibration missing'
            );
        } catch (error) {
            setBackendStatus(
                'aruco',
                'failed',
                getErrorMessage(
                    error
                )
            );
        }
    } catch (error) {
        setBackendStatus(
            'opencv',
            'failed',
            getErrorMessage(
                error
            )
        );

        setBackendStatus(
            'aruco',
            'failed',
            'OpenCV unavailable'
        );
    }
}

async function createLocalVisionFileset() {
    const supportsSimd =
        await FilesetResolver
            .isSimdSupported();

    const wasmConfig =
        config.tracking.mediapipe
            .wasm;

    const loaderAssetPath =
        supportsSimd
            ? wasmConfig
                .simdLoaderAssetPath
            : wasmConfig
                .noSimdLoaderAssetPath;

    const binaryAssetPath =
        supportsSimd
            ? wasmConfig
                .simdBinaryAssetPath
            : wasmConfig
                .noSimdBinaryAssetPath;

    const [
        loaderSource,
        binaryAsset
    ] =
        await Promise.all([
            window.trackingBridge
                .readTextAsset(
                    loaderAssetPath
                ),

            window.trackingBridge
                .readBinaryAsset(
                    binaryAssetPath
                )
        ]);

    const loaderUrl =
        createObjectUrl(
            loaderSource,
            'text/javascript'
        );

    const binaryUrl =
        createObjectUrl(
            normalizeBinaryAsset(
                binaryAsset
            ),
            'application/wasm'
        );

    return {
        wasmLoaderPath:
            loaderUrl,
        wasmBinaryPath:
            binaryUrl
    };
}

function createMediaPipeBaseOptions(
    modelAssetBuffer
) {
    const baseOptions = {
        modelAssetBuffer:
            normalizeBinaryAsset(
                modelAssetBuffer
            )
    };

    if (
        config.tracking.mediapipe
            .delegate ===
        'GPU'
    ) {
        baseOptions.delegate =
            'GPU';
    }

    return baseOptions;
}

function refreshMediaPipeStatus() {
    const handStatus =
        trackingState.backends
            .hands.status;

    const poseStatus =
        trackingState.backends
            .pose.status;

    if (
        handStatus === 'loading' ||
        poseStatus === 'loading'
    ) {
        setBackendStatus(
            'mediapipe',
            'loading'
        );

        return;
    }

    if (
        handStatus === 'ready' ||
        poseStatus === 'ready'
    ) {
        const message = [];

        if (
            handStatus !== 'ready'
        ) {
            message.push(
                'hands unavailable'
            );
        }

        if (
            poseStatus !== 'ready'
        ) {
            message.push(
                'pose unavailable'
            );
        }

        setBackendStatus(
            'mediapipe',
            'ready',
            message.length > 0
                ? message.join(', ')
                : null
        );

        return;
    }

    setBackendStatus(
        'mediapipe',
        'failed',
        'hands and pose unavailable'
    );
}

async function initializeMediaPipe() {
    setBackendStatus(
        'mediapipe',
        'loading',
        'reading local wasm'
    );

    setBackendStatus(
        'hands',
        'loading',
        'reading local model'
    );

    setBackendStatus(
        'pose',
        'loading',
        'reading local model'
    );

    let vision =
        null;

    try {
        vision =
            await withTimeout(
                createLocalVisionFileset(),
                INITIALIZATION_TIMEOUT_MS,
                'MediaPipe local WASM'
            );
    } catch (error) {
        const message =
            getErrorMessage(
                error
            );

        setBackendStatus(
            'hands',
            'failed',
            message
        );

        setBackendStatus(
            'pose',
            'failed',
            message
        );

        refreshMediaPipeStatus();

        return;
    }

    setBackendStatus(
        'mediapipe',
        'loading',
        'initializing wasm'
    );

    const [
        handModelResult,
        poseModelResult
    ] =
        await Promise.allSettled([
            window.trackingBridge
                .readBinaryAsset(
                    config.tracking
                        .mediapipe
                        .handModelAssetPath
                ),

            window.trackingBridge
                .readBinaryAsset(
                    config.tracking
                        .mediapipe
                        .poseModelAssetPath
                )
        ]);

    /*
   * Initialize MediaPipe tasks sequentially.
   *
   * Both tasks use the same local WASM fileset, but each createFromOptions()
   * creates its own MediaPipe WASM task instance.
   *
   * Serial initialization avoids racing two loader/module initializations
   * against the same local WASM runtime.
   */

    if (
        handModelResult.status ===
        'fulfilled'
    ) {
        try {
            handLandmarker =
                await withTimeout(
                    HandLandmarker.createFromOptions(
                        vision,
                        {
                            baseOptions:
                                createMediaPipeBaseOptions(
                                    handModelResult.value
                                ),

                            runningMode:
                                'VIDEO',

                            numHands:
                                config.tracking
                                    .mediapipe
                                    .numHands,

                            minHandDetectionConfidence:
                                config.tracking
                                    .mediapipe
                                    .minHandDetectionConfidence,

                            minHandPresenceConfidence:
                                config.tracking
                                    .mediapipe
                                    .minHandPresenceConfidence,

                            minTrackingConfidence:
                                config.tracking
                                    .mediapipe
                                    .minHandTrackingConfidence
                        }
                    ),
                    INITIALIZATION_TIMEOUT_MS,
                    'Hand Landmarker'
                );

            setBackendStatus(
                'hands',
                'ready'
            );
        } catch (error) {
            setBackendStatus(
                'hands',
                'failed',
                getErrorMessage(
                    error
                )
            );
        }
    } else {
        setBackendStatus(
            'hands',
            'failed',
            getErrorMessage(
                handModelResult.reason
            )
        );
    }

    /*
     * Wait for Hand Landmarker initialization to complete before creating the
     * second MediaPipe WASM task instance.
     */
    if (
        poseModelResult.status ===
        'fulfilled'
    ) {
        try {
            poseLandmarker =
                await withTimeout(
                    PoseLandmarker.createFromOptions(
                        vision,
                        {
                            baseOptions:
                                createMediaPipeBaseOptions(
                                    poseModelResult.value
                                ),

                            runningMode:
                                'VIDEO',

                            numPoses:
                                config.tracking
                                    .mediapipe
                                    .numPoses,

                            minPoseDetectionConfidence:
                                config.tracking
                                    .mediapipe
                                    .minPoseDetectionConfidence,

                            minPosePresenceConfidence:
                                config.tracking
                                    .mediapipe
                                    .minPosePresenceConfidence,

                            minTrackingConfidence:
                                config.tracking
                                    .mediapipe
                                    .minPoseTrackingConfidence,

                            outputSegmentationMasks:
                                false
                        }
                    ),
                    INITIALIZATION_TIMEOUT_MS,
                    'Pose Landmarker'
                );

            setBackendStatus(
                'pose',
                'ready'
            );
        } catch (error) {
            setBackendStatus(
                'pose',
                'failed',
                getErrorMessage(
                    error
                )
            );
        }
    } else {
        setBackendStatus(
            'pose',
            'failed',
            getErrorMessage(
                poseModelResult.reason
            )
        );
    }

    refreshMediaPipeStatus();
}

function hasValidMarkerPoseConfiguration() {
    const markerSizeM =
        config.tracking.opencv
            .markerSizeM;

    const intrinsics =
        config.tracking.opencv
            .intrinsics;

    return (
        isFiniteNumber(
            markerSizeM
        ) &&
        markerSizeM > 0 &&
        isFiniteNumber(
            intrinsics.fx
        ) &&
        intrinsics.fx > 0 &&
        isFiniteNumber(
            intrinsics.fy
        ) &&
        intrinsics.fy > 0 &&
        isFiniteNumber(
            intrinsics.cx
        ) &&
        isFiniteNumber(
            intrinsics.cy
        )
    );
}

function createCameraMatrix(
    cv
) {
    const intrinsics =
        config.tracking.opencv
            .intrinsics;

    const calibrationWidth =
        isFiniteNumber(
            intrinsics.imageWidthPx
        ) &&
            intrinsics.imageWidthPx > 0
            ? intrinsics.imageWidthPx
            : video.videoWidth;

    const calibrationHeight =
        isFiniteNumber(
            intrinsics.imageHeightPx
        ) &&
            intrinsics.imageHeightPx > 0
            ? intrinsics.imageHeightPx
            : video.videoHeight;

    const scaleX =
        video.videoWidth /
        calibrationWidth;

    const scaleY =
        video.videoHeight /
        calibrationHeight;

    return cv.matFromArray(
        3,
        3,
        cv.CV_64F,
        [
            intrinsics.fx * scaleX,
            0,
            intrinsics.cx * scaleX,

            0,
            intrinsics.fy * scaleY,
            intrinsics.cy * scaleY,

            0,
            0,
            1
        ]
    );
}

function createDistCoeffs(
    cv
) {
    const values =
        Array.isArray(
            config.tracking.opencv
                .intrinsics
                .distCoeffs
        )
            ? config.tracking.opencv
                .intrinsics
                .distCoeffs
            : [];

    if (
        values.length ===
        0
    ) {
        return new cv.Mat();
    }

    return cv.matFromArray(
        1,
        values.length,
        cv.CV_64F,
        values
    );
}

function readVector3(
    mat
) {
    const data =
        mat.data64F ||
        mat.data32F;

    return [
        data[0],
        data[1],
        data[2]
    ];
}

function readProjectedPoints(
    mat
) {
    const data =
        mat.data64F ||
        mat.data32F;

    const points = [];

    for (
        let index = 0;
        index + 1 < data.length;
        index += 2
    ) {
        points.push({
            x:
                data[index],
            y:
                data[index + 1]
        });
    }

    return points;
}

function estimateMarkerPose(
    corners
) {
    if (
        !hasValidMarkerPoseConfiguration()
    ) {
        return null;
    }

    const cv =
        openCvContext.cv;

    const markerSizeM =
        config.tracking.opencv
            .markerSizeM;

    const halfSize =
        markerSizeM / 2;

    const objectPoints =
        cv.matFromArray(
            4,
            1,
            cv.CV_32FC3,
            [
                -halfSize, halfSize, 0,
                halfSize, halfSize, 0,
                halfSize, -halfSize, 0,
                -halfSize, -halfSize, 0
            ]
        );

    const imagePoints =
        cv.matFromArray(
            4,
            1,
            cv.CV_32FC2,
            corners.flatMap(
                (corner) => [
                    corner.x,
                    corner.y
                ]
            )
        );

    const cameraMatrix =
        createCameraMatrix(
            cv
        );

    const distCoeffs =
        createDistCoeffs(
            cv
        );

    const rvec =
        new cv.Mat(
            3,
            1,
            cv.CV_64F
        );

    const tvec =
        new cv.Mat(
            3,
            1,
            cv.CV_64F
        );

    const rotationMatrix =
        new cv.Mat();

    const projectedMarker =
        new cv.Mat();

    const projectedAxes =
        new cv.Mat();

    const axisLengthM =
        Math.min(
            config.tracking.opencv
                .axisLengthM,
            markerSizeM
        );

    const axisObjectPoints =
        cv.matFromArray(
            4,
            1,
            cv.CV_32FC3,
            [
                0, 0, 0,
                axisLengthM, 0, 0,
                0, axisLengthM, 0,
                0, 0, axisLengthM
            ]
        );

    try {
        const solved =
            cv.solvePnP(
                objectPoints,
                imagePoints,
                cameraMatrix,
                distCoeffs,
                rvec,
                tvec
            );

        if (!solved) {
            return null;
        }

        cv.Rodrigues(
            rvec,
            rotationMatrix
        );

        cv.projectPoints(
            objectPoints,
            rvec,
            tvec,
            cameraMatrix,
            distCoeffs,
            projectedMarker
        );

        cv.projectPoints(
            axisObjectPoints,
            rvec,
            tvec,
            cameraMatrix,
            distCoeffs,
            projectedAxes
        );

        const projectedCorners =
            readProjectedPoints(
                projectedMarker
            );

        let squaredError =
            0;

        for (
            let index = 0;
            index < corners.length;
            ++index
        ) {
            const dx =
                corners[index].x -
                projectedCorners[index].x;

            const dy =
                corners[index].y -
                projectedCorners[index].y;

            squaredError +=
                dx * dx +
                dy * dy;
        }

        const reprojectionErrorPx =
            Math.sqrt(
                squaredError /
                corners.length
            );

        const rotation =
            rotationMatrix.data64F ||
            rotationMatrix.data32F;

        const translationM =
            readVector3(
                tvec
            );

        return {
            coordinateSystem:
                'OpenCV camera: +X right, +Y down, +Z forward',

            translationM,

            rotationVector:
                readVector3(
                    rvec
                ),

            transformMatrixRowMajor: [
                rotation[0],
                rotation[1],
                rotation[2],
                translationM[0],

                rotation[3],
                rotation[4],
                rotation[5],
                translationM[1],

                rotation[6],
                rotation[7],
                rotation[8],
                translationM[2],

                0,
                0,
                0,
                1
            ],

            reprojectionErrorPx,

            axisImagePoints:
                readProjectedPoints(
                    projectedAxes
                )
        };
    } finally {
        objectPoints.delete();
        imagePoints.delete();
        cameraMatrix.delete();
        distCoeffs.delete();
        rvec.delete();
        tvec.delete();
        rotationMatrix.delete();
        projectedMarker.delete();
        projectedAxes.delete();
        axisObjectPoints.delete();
    }
}

function ensureOpenCvFrameBuffers() {
    if (!openCvContext) {
        return;
    }

    const {
        cv
    } =
        openCvContext;

    const width =
        video.videoWidth;

    const height =
        video.videoHeight;

    if (
        width <= 0 ||
        height <= 0
    ) {
        throw new Error(
            'Video dimensions are not available.'
        );
    }

    const rgbaMatches =
        openCvContext.frameRgba &&
        openCvContext.frameRgba.cols ===
        width &&
        openCvContext.frameRgba.rows ===
        height;

    const grayMatches =
        openCvContext.frameGray &&
        openCvContext.frameGray.cols ===
        width &&
        openCvContext.frameGray.rows ===
        height;

    if (
        rgbaMatches &&
        grayMatches
    ) {
        return;
    }

    if (
        openCvContext.frameRgba
    ) {
        openCvContext.frameRgba.delete();
    }

    if (
        openCvContext.frameGray
    ) {
        openCvContext.frameGray.delete();
    }

    openCvContext.frameRgba =
        new cv.Mat(
            height,
            width,
            cv.CV_8UC4
        );

    openCvContext.frameGray =
        new cv.Mat(
            height,
            width,
            cv.CV_8UC1
        );

    console.log(
        `OpenCV frame buffers resized to ${width}x${height}`
    );
}

function detectMarkers() {
    if (!openCvContext) {
        return {
            detections: [],
            selected: null
        };
    }

    ensureOpenCvFrameBuffers();

    const {
        cv,
        detector,
        capture,
        frameRgba,
        frameGray
    } =
        openCvContext;

    capture.read(
        frameRgba
    );

    cv.cvtColor(
        frameRgba,
        frameGray,
        cv.COLOR_RGBA2GRAY
    );

    const corners =
        new cv.MatVector();

    const ids =
        new cv.Mat();

    const rejected =
        new cv.MatVector();

    const detections = [];

    try {
        detector.detectMarkers(
            frameGray,
            corners,
            ids,
            rejected
        );

        const idData =
            ids.data32S ||
            [];

        for (
            let index = 0;
            index < corners.size();
            ++index
        ) {
            const cornerMat =
                corners.get(
                    index
                );

            try {
                const data =
                    cornerMat.data32F ||
                    cornerMat.data64F;

                const markerCorners =
                    [];

                for (
                    let cornerIndex = 0;
                    cornerIndex < 4;
                    ++cornerIndex
                ) {
                    markerCorners.push({
                        x:
                            data[
                            cornerIndex *
                            2
                            ],
                        y:
                            data[
                            cornerIndex *
                            2 +
                            1
                            ]
                    });
                }

                detections.push({
                    id:
                        idData[index],
                    corners:
                        markerCorners,
                    poseCamera:
                        null
                });
            } finally {
                cornerMat.delete();
            }
        }
    } finally {
        corners.delete();
        ids.delete();
        rejected.delete();
    }

    const configuredMarkerId =
        config.tracking.opencv
            .markerId;

    let selected =
        null;

    if (
        configuredMarkerId ===
        null ||
        configuredMarkerId ===
        undefined
    ) {
        selected =
            detections[0] ||
            null;
    } else {
        selected =
            detections.find(
                (detection) =>
                    detection.id ===
                    configuredMarkerId
            ) ||
            null;
    }

    if (selected) {
        selected.poseCamera =
            estimateMarkerPose(
                selected.corners
            );
    }

    return {
        detections,
        selected
    };
}

function drawPoseOverlay() {
    const landmarks =
        latestRawPoseResult
            ?.landmarks ||
        [];

    for (
        const poseLandmarks of
        landmarks
    ) {
        drawingUtils.drawConnectors(
            poseLandmarks,
            PoseLandmarker
                .POSE_CONNECTIONS,
            {
                color: '#ffffff',
                lineWidth: 2
            }
        );

        drawingUtils.drawLandmarks(
            poseLandmarks,
            {
                color: '#ffcc66',
                radius: 2
            }
        );
    }
}

function drawHandOverlay() {
    const landmarks =
        latestRawHandResult
            ?.landmarks ||
        [];

    for (
        let index = 0;
        index < landmarks.length;
        ++index
    ) {
        const handLandmarks =
            landmarks[index];

        drawingUtils.drawConnectors(
            handLandmarks,
            HandLandmarker
                .HAND_CONNECTIONS,
            {
                color: '#00d8ff',
                lineWidth: 3
            }
        );

        drawingUtils.drawLandmarks(
            handLandmarks,
            {
                color: '#ff4d8d',
                radius: 3
            }
        );

        const category =
            getHandCategory(
                latestRawHandResult,
                index
            );

        const rawLabel =
            category
                ?.categoryName ||
            category
                ?.displayName ||
            'unknown';

        const label =
            normalizeHandednessLabel(
                rawLabel
            ) ||
            'unknown';

        const wrist =
            handLandmarks[0];

        if (wrist) {
            overlayContext.fillStyle =
                '#ffffff';

            overlayContext.font =
                '16px Consolas, monospace';

            overlayContext.fillText(
                `${label} ${formatNumber(
                    category?.score,
                    2
                )}`,
                wrist.x *
                overlay.width +
                8,
                wrist.y *
                overlay.height -
                8
            );
        }
    }
}

function drawMarkerOverlay() {
    overlayContext.save();

    overlayContext.font =
        '16px Consolas, monospace';

    overlayContext.lineWidth =
        3;

    for (
        const detection of
        latestMarkerDebug
            .detections
    ) {
        if (
            detection.corners.length !==
            4
        ) {
            continue;
        }

        overlayContext.strokeStyle =
            '#ffd166';

        overlayContext.beginPath();

        overlayContext.moveTo(
            detection.corners[0].x,
            detection.corners[0].y
        );

        for (
            let index = 1;
            index <
            detection.corners.length;
            ++index
        ) {
            overlayContext.lineTo(
                detection.corners[
                    index
                ].x,
                detection.corners[
                    index
                ].y
            );
        }

        overlayContext.closePath();
        overlayContext.stroke();

        overlayContext.fillStyle =
            '#ffd166';

        overlayContext.fillText(
            `ID ${detection.id}`,
            detection.corners[0].x +
            6,
            detection.corners[0].y -
            8
        );
    }

    const pose =
        latestMarkerDebug
            .selected
            ?.poseCamera;

    const axis =
        pose?.axisImagePoints;

    if (
        Array.isArray(axis) &&
        axis.length >= 4
    ) {
        const origin =
            axis[0];

        const drawAxis = (
            point,
            color
        ) => {
            overlayContext.strokeStyle =
                color;

            overlayContext.beginPath();

            overlayContext.moveTo(
                origin.x,
                origin.y
            );

            overlayContext.lineTo(
                point.x,
                point.y
            );

            overlayContext.stroke();
        };

        drawAxis(
            axis[1],
            '#ff4040'
        );

        drawAxis(
            axis[2],
            '#40ff70'
        );

        drawAxis(
            axis[3],
            '#4090ff'
        );
    }

    overlayContext.restore();
}

function drawOverlay() {
    if (
        overlay.width !==
        video.videoWidth ||
        overlay.height !==
        video.videoHeight
    ) {
        overlay.width =
            video.videoWidth;

        overlay.height =
            video.videoHeight;
    }

    overlayContext.clearRect(
        0,
        0,
        overlay.width,
        overlay.height
    );

    drawPoseOverlay();
    drawHandOverlay();
    drawMarkerOverlay();
}

function updateCameraInfo() {
    cameraInfoElement.textContent =
        [
            `device: ${trackingState.camera.deviceLabel || 'unknown'}`,
            `resolution: ${trackingState.camera.widthPx}x${trackingState.camera.heightPx}`,
            `camera fps: ${formatNumber(trackingState.camera.frameRateHz, 2)}`,
            `processing fps: ${config.tracking.processingFps}`
        ].join('\n');
}

function updateMarkerInfo() {
    const marker =
        trackingState.marker;

    const pose =
        marker.poseCamera;

    const lines = [
        `detections: ${marker.detections.length}`,
        `selected id: ${marker.selectedId ?? 'none'}`,
        `dictionary: ${config.tracking.opencv.dictionary}`,
        `marker size: ${isFiniteNumber(
            config.tracking.opencv
                .markerSizeM
        )
            ? `${config.tracking.opencv.markerSizeM} m`
            : 'not configured'
        }`
    ];

    if (!marker.tracked) {
        lines.push(
            'pose: no selected marker'
        );
    } else if (pose) {
        lines.push(
            `x: ${formatNumber(pose.translationM[0])} m`,
            `y: ${formatNumber(pose.translationM[1])} m`,
            `z: ${formatNumber(pose.translationM[2])} m`,
            `reprojection: ${formatNumber(pose.reprojectionErrorPx, 2)} px`
        );
    } else {
        lines.push(
            'pose: unavailable until marker size and camera intrinsics are configured'
        );
    }

    markerInfoElement.textContent =
        lines.join('\n');
}

function updateHandsInfo() {
    const describeHand = (
        name,
        hand
    ) => {
        if (!hand.tracked) {
            return `${name}: not tracked`;
        }

        return [
            `${name}: tracked`,
            `  handedness confidence: ${formatNumber(hand.handednessConfidence, 3)}`,
            `  image landmarks: ${hand.imageLandmarks.length}`,
            `  local 3D landmarks: ${hand.worldLandmarks.length}`,
            '  Workbench landmarks: unavailable'
        ].join('\n');
    };

    handsInfoElement.textContent =
        [
            describeHand(
                'left',
                trackingState.hands.left
            ),
            describeHand(
                'right',
                trackingState.hands.right
            ),
            `unassigned: ${trackingState.hands.unassigned.length}`
        ].join('\n');
}

function updateBodyInfo() {
    bodyInfoElement.textContent =
        [
            `tracked: ${trackingState.body.tracked ? 'yes' : 'no'}`,
            `image landmarks: ${trackingState.body.imageLandmarks.length}`,
            `local 3D landmarks: ${trackingState.body.worldLandmarks.length}`,
            'Workbench landmarks: unavailable'
        ].join('\n');
}

function updateTimingsInfo() {
    timingsInfoElement.textContent =
        [
            `opencv: ${formatNumber(trackingState.timings.opencvMs, 2)} ms`,
            `hands: ${formatNumber(trackingState.timings.handsMs, 2)} ms`,
            `pose: ${formatNumber(trackingState.timings.poseMs, 2)} ms`,
            `total: ${formatNumber(trackingState.timings.totalMs, 2)} ms`
        ].join('\n');
}

function updateDebugPanel(
    timestampMs
) {
    updateCameraInfo();
    updateMarkerInfo();
    updateHandsInfo();
    updateBodyInfo();
    updateTimingsInfo();

    if (
        timestampMs -
        lastStateJsonUpdateMs >=
        500
    ) {
        trackingStateJsonElement
            .textContent =
            JSON.stringify(
                trackingState,
                null,
                2
            );

        lastStateJsonUpdateMs =
            timestampMs;
    }
}

function runOpenCvFrame() {
    if (
        trackingState.backends
            .aruco.status !==
        'ready' ||
        !openCvContext
    ) {
        trackingState.timings.opencvMs =
            null;

        return;
    }

    const start =
        performance.now();

    try {
        updateMarkerState(
            detectMarkers()
        );
    } catch (error) {
        setBackendStatus(
            'aruco',
            'failed',
            getErrorMessage(
                error
            )
        );

        updateMarkerState({
            detections: [],
            selected: null
        });
    } finally {
        trackingState.timings.opencvMs =
            performance.now() -
            start;
    }
}

function runHandFrame(
    timestampMs
) {
    if (
        trackingState.backends
            .hands.status !==
        'ready' ||
        !handLandmarker
    ) {
        trackingState.timings.handsMs =
            null;

        return;
    }

    const start =
        performance.now();

    try {
        latestRawHandResult =
            handLandmarker
                .detectForVideo(
                    video,
                    timestampMs
                );

        updateHandsState(
            latestRawHandResult
        );
    } catch (error) {
        latestRawHandResult =
            null;

        trackingState.hands = {
            left:
                createEmptyHandState(),
            right:
                createEmptyHandState(),
            unassigned: []
        };

        setBackendStatus(
            'hands',
            'failed',
            getErrorMessage(
                error
            )
        );

        refreshMediaPipeStatus();
    } finally {
        trackingState.timings.handsMs =
            performance.now() -
            start;
    }
}

function runPoseFrame(
    timestampMs
) {
    if (
        trackingState.backends
            .pose.status !==
        'ready' ||
        !poseLandmarker
    ) {
        trackingState.timings.poseMs =
            null;

        return;
    }

    const start =
        performance.now();

    try {
        latestRawPoseResult =
            poseLandmarker
                .detectForVideo(
                    video,
                    timestampMs
                );

        updateBodyState(
            latestRawPoseResult
        );
    } catch (error) {
        latestRawPoseResult =
            null;

        updateBodyState(
            null
        );

        setBackendStatus(
            'pose',
            'failed',
            getErrorMessage(
                error
            )
        );

        refreshMediaPipeStatus();
    } finally {
        trackingState.timings.poseMs =
            performance.now() -
            start;
    }
}

function processTrackingFrame(
    timestampMs
) {
    const frameStart =
        performance.now();

    runOpenCvFrame();
    runHandFrame(
        timestampMs
    );
    runPoseFrame(
        timestampMs
    );

    trackingState.timings.totalMs =
        performance.now() -
        frameStart;

    sequence++;

    drawOverlay();

    updateDebugPanel(
        timestampMs
    );

    publishTrackingState();
}

function trackingLoop(
    timestampMs
) {
    requestAnimationFrame(
        trackingLoop
    );

    if (
        trackingState.backends
            .camera.status !==
        'ready'
    ) {
        return;
    }

    const intervalMs =
        1000 /
        config.tracking
            .processingFps;

    if (
        processing ||
        timestampMs -
        lastProcessingTimestampMs <
        intervalMs ||
        video.readyState <
        HTMLMediaElement
            .HAVE_CURRENT_DATA
    ) {
        return;
    }

    processing =
        true;

    lastProcessingTimestampMs =
        timestampMs;

    try {
        processTrackingFrame(
            timestampMs
        );

        if (
            trackingState.backends
                .loop.status !==
            'running'
        ) {
            setBackendStatus(
                'loop',
                'running'
            );
        }
    } catch (error) {
        setBackendStatus(
            'loop',
            'failed',
            getErrorMessage(
                error
            )
        );
    } finally {
        processing =
            false;
    }
}

function cleanupOpenCv() {
    if (!openCvContext) {
        return;
    }

    const resources = [
        openCvContext.capture,
        openCvContext.frameRgba,
        openCvContext.frameGray,
        openCvContext.detector,
        openCvContext
            .detectorParameters,
        openCvContext.dictionary
    ];

    for (
        const resource of
        resources
    ) {
        if (
            resource &&
            typeof resource.delete ===
            'function'
        ) {
            resource.delete();
        }
    }

    openCvContext =
        null;
}

function cleanup() {
    if (
        handLandmarker &&
        typeof handLandmarker.close ===
        'function'
    ) {
        handLandmarker.close();
    }

    if (
        poseLandmarker &&
        typeof poseLandmarker.close ===
        'function'
    ) {
        poseLandmarker.close();
    }

    cleanupOpenCv();

    if (cameraStream) {
        for (
            const track of
            cameraStream.getTracks()
        ) {
            track.stop();
        }
    }

    for (
        const url of
        localObjectUrls
    ) {
        URL.revokeObjectURL(
            url
        );
    }

    localObjectUrls.clear();
}

async function start() {
    try {
        config =
            await window.trackingBridge
                .getConfig();
    } catch (error) {
        setBackendStatus(
            'camera',
            'failed',
            `config: ${getErrorMessage(error)}`
        );

        setBackendStatus(
            'loop',
            'failed',
            'configuration unavailable'
        );

        return;
    }

    /*
     * Camera first.
     *
     * The raw video becomes visible before OpenCV or MediaPipe initialization.
     */
    try {
        await openCamera();
    } catch (error) {
        setBackendStatus(
            'camera',
            'failed',
            getErrorMessage(
                error
            )
        );

        setBackendStatus(
            'loop',
            'failed',
            'camera unavailable'
        );

        updateDebugPanel(
            performance.now()
        );

        return;
    }

    updateDebugPanel(
        performance.now()
    );

    setBackendStatus(
        'loop',
        'starting'
    );

    requestAnimationFrame(
        trackingLoop
    );

    /*
     * Both backends initialize independently.
     *
     * All assets are read from local packaged files through Electron IPC.
     */
    initializeOpenCv();

    initializeMediaPipe();
}

window.addEventListener(
    'beforeunload',
    cleanup
);

start();