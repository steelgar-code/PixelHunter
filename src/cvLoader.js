// Loads the pinned OpenCV.js build and checks that everything the pipeline uses is there.
//
// The 4.12 build is an old-style emscripten module: the script sets a global `cv` that is a
// "thenable" Module object, ready once `onRuntimeInitialized` fires. Awaiting it directly loops
// forever (its then() resolves with itself), so we wait on the callback and drop `then` after.

export const CV_URL = 'vendor/opencv-4.12.0.js';
export const CV_VERSION = '4.12.0';

// Functions and classes used anywhere in the pipeline (M1–M4).
export const REQUIRED_FUNCTIONS = [
    'Mat', 'MatVector', 'Size', 'Point', 'Scalar', 'Rect', 'TermCriteria',
    'matFromArray', 'matFromImageData', 'getStructuringElement',
    'cvtColor', 'resize', 'goodFeaturesToTrack', 'calcOpticalFlowPyrLK', 'findHomography',
    'warpPerspective', 'absdiff', 'subtract', 'add', 'erode', 'dilate', 'threshold',
    'bitwise_and', 'connectedComponentsWithStats', 'fillConvexPoly', 'mean', 'GaussianBlur',
    'morphologyEx', 'min', 'max', 'boxFilter', 'divide', 'compare',
];

export const REQUIRED_CONSTANTS = [
    'CV_8U', 'CV_8UC4', 'CV_32F', 'CV_32FC2', 'CV_32S', 'CV_32SC2', 'CV_64F',
    'COLOR_RGBA2GRAY', 'INTER_LINEAR', 'INTER_AREA', 'INTER_NEAREST', 'WARP_INVERSE_MAP',
    'BORDER_CONSTANT', 'THRESH_BINARY', 'THRESH_TOZERO', 'THRESH_TOZERO_INV', 'CMP_GT', 'MORPH_RECT', 'MORPH_OPEN', 'RANSAC', 'LINE_8',
    'TermCriteria_COUNT', 'TermCriteria_EPS',
];

// Names missing from a loaded cv object, as { functions, constants }.
export function checkCv(cv) {
    return {
        functions: REQUIRED_FUNCTIONS.filter(n => typeof cv[n] !== 'function'),
        constants: REQUIRED_CONSTANTS.filter(n => typeof cv[n] !== 'number'),
    };
}

function loadScript(url) {
    return new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = url;
        s.async = true;
        s.onload = resolve;
        s.onerror = () => reject(new Error(`Could not load ${url}`));
        document.head.appendChild(s);
    });
}

// Resolves with { cv, ms } once the runtime is ready; rejects if the file fails to load or
// the runtime does not start within `timeoutMs`.
export async function loadCv({ url = CV_URL, timeoutMs = 60000 } = {}) {
    const t0 = performance.now();
    await loadScript(url);
    let cv = window.cv;
    if (!cv) throw new Error(`${url} did not define cv`);
    if (typeof cv.Mat !== 'function') {
        if (cv instanceof Promise) {
            cv = await cv;
        } else {
            cv = await new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('OpenCV.js runtime did not start')), timeoutMs);
                const prev = cv.onRuntimeInitialized;
                cv.onRuntimeInitialized = () => {
                    clearTimeout(timer);
                    if (prev) prev();
                    const ready = window.cv;
                    delete ready.then;      // resolving with a thenable would loop forever
                    resolve(ready);
                };
            });
        }
    }
    if (typeof cv.then === 'function' && !(cv instanceof Promise)) delete cv.then;
    window.cv = cv;
    return { cv, ms: performance.now() - t0 };
}
