// Tunable parameters: one definition list drives defaults, ranges, the sliders and persistence.
// Values are saved in localStorage and can be overridden from the URL hash
// (e.g. #mode=everyFrame&threshold=30) for repeatable runs. Pure: no DOM except the two
// storage helpers, which take their inputs as arguments.

export const PARAM_DEFS = [
    { key: 'mode', label: 'Processing', group: 'playback', type: 'choice', default: 'realtime',
      choices: [['realtime', 'Real-time'], ['everyFrame', 'Every frame']] },
    { key: 'speed', label: 'Speed', group: 'playback', type: 'choice', default: '1',
      choices: [['1', '×1'], ['2', '×2'], ['3', '×3']] },
    { key: 'view', label: 'View', group: 'view', type: 'choice', default: 'original',
      choices: [['original', 'Original'], ['stabilised', 'Stabilised'], ['points', 'Points'], ['diff', 'Raw diff'], ['mask', 'Mask']] },
    { key: 'showCandidates', label: 'Unconfirmed candidates', group: 'view', type: 'bool', default: true },
    { key: 'showBuilding', label: 'Tracks building up (dashed, with progress)', group: 'view', type: 'bool', default: true },
    { key: 'showTruth', label: 'Ground truth (synthetic)', group: 'view', type: 'bool', default: true },
    { key: 'showZones', label: 'Detection-area zones', group: 'view', type: 'bool', default: true },
    { key: 'showHud', label: 'Readout on the video (fps, candidates, objects)', group: 'view', type: 'bool', default: true },

    // the objects panel
    { key: 'cards', label: 'A card on the video for each new object', group: 'objects', type: 'bool', default: true },
    { key: 'pauseOnNew', label: 'Pause when a new object is confirmed', group: 'objects', type: 'bool', default: false },

    // detection (detect.js)
    { key: 'detectMode', label: 'Detection', group: 'detect', type: 'choice', default: 'adaptive',
      choices: [['robust', 'Robust (3 frames)'], ['adaptive', 'Adaptive (3 frames)'], ['basic', 'Basic (2 frames)']] },
    { key: 'procWidth', label: 'Processing width', group: 'detect', type: 'choice', default: '0',
      choices: [['0', 'Source'], ['1920', '1920'], ['1280', '1280'], ['960', '960'], ['640', '640']] },
    { key: 'stride', label: 'Frame stride', group: 'detect', type: 'number', default: 1, min: 1, max: 12, step: 1, unit: 'frames' },
    { key: 'threshold', label: 'Diff threshold', group: 'detect', type: 'number', default: 20, min: 5, max: 100, step: 1, unit: 'grey' },
    { key: 'sigmas', label: 'Adaptive threshold', group: 'detect', type: 'number', default: 7, min: 3, max: 12, step: 0.5, unit: 'σ' },
    { key: 'weakMargin', label: 'Adaptive weak margin', group: 'detect', type: 'number', default: 2.5, min: 0, max: 4, step: 0.5, unit: 'σ' },
    { key: 'minContrast', label: 'Adaptive min contrast', group: 'detect', type: 'number', default: 4, min: 1, max: 30, step: 1, unit: 'grey' },
    { key: 'minMean', label: 'Adaptive min mean contrast', group: 'detect', type: 'number', default: 0, min: 0, max: 8, step: 0.5, unit: 'grey' },
    { key: 'minArea', label: 'Min blob area', group: 'detect', type: 'number', default: 1, min: 1, max: 50, step: 1, unit: 'px' },
    { key: 'maxArea', label: 'Max blob area', group: 'detect', type: 'number', default: 400, min: 10, max: 5000, step: 10, unit: 'px' },
    { key: 'borderMargin', label: 'Border margin', group: 'detect', type: 'number', default: 3, min: 0, max: 20, step: 1, unit: 'px' },
    { key: 'brightness', label: 'Match brightness', group: 'detect', type: 'bool', default: true },
    { key: 'blur', label: '3×3 blur', group: 'detect', type: 'bool', default: false },
    { key: 'open', label: '3×3 opening (drops 1–2 px blobs)', group: 'detect', type: 'bool', default: false },
    { key: 'shiftCheck', label: 'Drop background-shift edges (trees, branches)', group: 'detect', type: 'bool', default: false, preset: false },
    { key: 'shiftMax', label: 'Max background shift', group: 'detect', type: 'number', default: 2, min: 1, max: 5, step: 1, unit: 'px', preset: false },
    { key: 'zonesMotion', label: 'Also ignore zones for camera motion', group: 'zones', type: 'bool', default: true },

    // temporal confirmation (tracker.js)
    { key: 'confirmBy', label: 'Confirm by', group: 'track', type: 'choice', default: 'count',
      choices: [['count', 'N of M frames'], ['evidence', 'Evidence']] },
    { key: 'minAge', label: 'Min track age', group: 'track', type: 'number', default: 0.5, min: 0, max: 3, step: 0.1, unit: 's', when: { confirmBy: 'evidence' } },
    { key: 'minEvidence', label: 'Min evidence', group: 'track', type: 'number', default: 6, min: 1, max: 40, step: 0.5, unit: '×', when: { confirmBy: 'evidence' } },
    { key: 'maxGap', label: 'Max gap while building', group: 'track', type: 'number', default: 3, min: 0, max: 15, step: 1, unit: 'frames', when: { confirmBy: 'evidence' } },
    { key: 'confirmN', label: 'Confirm: seen in N', group: 'track', type: 'number', default: 3, min: 1, max: 10, step: 1, unit: 'frames', when: { confirmBy: 'count' } },
    { key: 'confirmM', label: '… of the last M', group: 'track', type: 'number', default: 5, min: 2, max: 20, step: 1, unit: 'frames', when: { confirmBy: 'count' } },
    { key: 'gateBase', label: 'Association gate', group: 'track', type: 'number', default: 4, min: 1, max: 30, step: 1, unit: 'px' },
    { key: 'maxSpeed', label: 'Max speed (new tracks)', group: 'track', type: 'number', default: 12, min: 2, max: 60, step: 1, unit: 'px/frame' },
    { key: 'minTravel', label: 'Min travel to confirm', group: 'track', type: 'number', default: 3, min: 0, max: 30, step: 1, unit: 'px' },
    { key: 'holdFrames', label: 'Keep lost tracks', group: 'track', type: 'number', default: 50, min: 0, max: 250, step: 5, unit: 'frames' },
    { key: 'pathCheck', label: 'Confirm steady paths only', group: 'track', type: 'bool', default: true },
    { key: 'pathTolerance', label: 'Path tolerance', group: 'track', type: 'number', default: 1.5, min: 0.5, max: 6, step: 0.1, unit: 'px' },
    { key: 'crowdGate', label: 'Tighter matching where crowded', group: 'track', type: 'bool', default: true },
    { key: 'motionPause', label: 'Pause tracks without camera motion', group: 'track', type: 'bool', default: true },

    // camera motion (egomotion.js)
    { key: 'estWidth', label: 'Estimation width', group: 'motion', type: 'number', default: 320, min: 160, max: 640, step: 16, unit: 'px' },
    { key: 'features', label: 'Features', group: 'motion', type: 'number', default: 400, min: 100, max: 1000, step: 50 },
    { key: 'lkWin', label: 'LK window', group: 'motion', type: 'number', default: 21, min: 9, max: 31, step: 2, unit: 'px' },
    { key: 'lkLevels', label: 'LK pyramid levels', group: 'motion', type: 'number', default: 3, min: 1, max: 4, step: 1 },
    { key: 'fbMax', label: 'Forward-backward max', group: 'motion', type: 'number', default: 1, min: 0.3, max: 3, step: 0.1, unit: 'px' },
    { key: 'reseedBelow', label: 'Re-seed below', group: 'motion', type: 'number', default: 100, min: 30, max: 300, step: 10, unit: 'points' },
    { key: 'ransacPx', label: 'RANSAC threshold', group: 'motion', type: 'number', default: 2, min: 0.5, max: 5, step: 0.1, unit: 'px' },
    { key: 'minInliers', label: 'Min inliers', group: 'motion', type: 'number', default: 30, min: 8, max: 200, step: 1 },
    { key: 'minInlierRatio', label: 'Min inlier ratio', group: 'motion', type: 'number', default: 0.5, min: 0.1, max: 0.95, step: 0.05 },

    // Test aid: random translation of up to this many px added to each fitted H. Not saved.
    { key: 'hJitter', label: 'H jitter', group: 'debug', type: 'number', default: 0, min: 0, max: 3, step: 0.25, unit: 'px', persist: false },
    // Busy-waits this long per frame, to test the frame loop without a pipeline. Not saved.
    { key: 'simLoad', label: 'Simulated load', group: 'debug', type: 'number', default: 0,
      min: 0, max: 500, step: 5, unit: 'ms', persist: false },
];

const DEFS = new Map(PARAM_DEFS.map(d => [d.key, d]));

// Sensitivity presets: starting points for detection, confirmation and camera motion, to tune
// from by hand. They set those groups only (not playback, view or zones), and leave options
// marked preset: false alone (the background-shift check). Mid is the defaults.
// Areas are in processing-resolution px.
const MID = Object.fromEntries(PARAM_DEFS.filter(d => ['detect', 'track', 'motion'].includes(d.group) && d.preset !== false).map(d => [d.key, d.default]));
export const PRESETS = {
    highest: {
        label: 'Highest',
        hint: 'fainter 1–3 px objects (contrast ~10–15): adaptive at 6σ, stricter confirmation (4 of 6), finer camera motion; slower to run. Slow movers: raise Frame stride',
        values: {
            ...MID,
            detectMode: 'adaptive', sigmas: 6, weakMargin: 2,
            confirmN: 4, confirmM: 6, minTravel: 2, holdFrames: 75,
            estWidth: 480, features: 600,
        },
    },
    mid: {
        label: 'Mid',
        hint: 'the defaults: adaptive detector at 7σ, objects 2–20 px down to contrast ~15, ≥ 2 px/frame',
        values: { ...MID },
    },
    low: {
        label: 'Low',
        hint: 'high-contrast objects ≥ 4 px at 960 px, fast (up to 30 px/frame); fastest, fewest false alarms',
        values: {
            ...MID,
            detectMode: 'robust', procWidth: '960', stride: 1, threshold: 35, minArea: 6, maxArea: 3000, borderMargin: 3, blur: true, open: false,
            confirmN: 3, confirmM: 5, gateBase: 6, maxSpeed: 30, minTravel: 5, holdFrames: 25,
            estWidth: 320, features: 400, lkWin: 25, lkLevels: 4, ransacPx: 2.5,
        },
    },
};

// The preset whose values all match `p`, or null.
export function matchingPreset(p) {
    for (const [key, pr] of Object.entries(PRESETS)) {
        if (Object.entries(pr.values).every(([k, v]) => String(p[k]) === String(v))) return key;
    }
    return null;
}

export function defaults() {
    return Object.fromEntries(PARAM_DEFS.map(d => [d.key, d.default]));
}

// Coerces a raw value (string from the hash, or anything from storage) to the def's type and
// range; returns undefined when it can't be used.
export function coerce(key, raw) {
    const d = DEFS.get(key);
    if (!d || raw === undefined || raw === null) return undefined;
    if (d.type === 'choice') {
        const v = String(raw);
        return d.choices.some(([c]) => c === v) ? v : undefined;
    }
    if (d.type === 'bool') {
        if (raw === true || raw === 'true' || raw === '1') return true;
        if (raw === false || raw === 'false' || raw === '0') return false;
        return undefined;
    }
    const n = Number(raw);
    if (!Number.isFinite(n)) return undefined;
    return Math.min(d.max, Math.max(d.min, n));
}

// Merges saved values, then a preset named in the hash (preset=highest), then hash values over
// the defaults.
export function resolveParams(saved, hash) {
    const p = defaults();
    const preset = hash && PRESETS[hash.preset];
    for (const src of [saved || {}, preset ? preset.values : {}, hash || {}]) {
        for (const [k, raw] of Object.entries(src)) {
            const v = coerce(k, raw);
            if (v !== undefined) p[k] = v;
        }
    }
    return p;
}

export function parseHash(hash) {
    const out = {};
    for (const part of String(hash || '').replace(/^#/, '').split('&')) {
        if (!part) continue;
        // split at the first '=' only: values (a URL) may contain more
        const i = part.indexOf('=');
        const k = i < 0 ? part : part.slice(0, i), v = i < 0 ? '' : part.slice(i + 1);
        try { out[decodeURIComponent(k)] = decodeURIComponent(v); } catch { out[k] = v; }
    }
    return out;
}

// Only parameters marked persistable and different from the default are written.
export function toSaved(p) {
    const out = {};
    for (const d of PARAM_DEFS) {
        if (d.persist === false || p[d.key] === d.default) continue;
        out[d.key] = p[d.key];
    }
    return out;
}

export const STORAGE_KEY = 'pixelhunter.params.v1';

export function loadSaved(storage) {
    try {
        return JSON.parse(storage.getItem(STORAGE_KEY) || '{}') || {};
    } catch {
        return {};
    }
}

export function save(storage, p) {
    try {
        storage.setItem(STORAGE_KEY, JSON.stringify(toSaved(p)));
    } catch {
        // private mode or storage full: parameters just aren't remembered
    }
}
