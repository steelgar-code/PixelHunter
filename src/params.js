// Tunable parameters: one definition list drives defaults, ranges, the sliders and persistence.
// Values are saved in localStorage and can be overridden from the URL hash
// (e.g. #mode=everyFrame&threshold=30) for repeatable runs. Pure: no DOM except the two
// storage helpers, which take their inputs as arguments.

export const PARAM_DEFS = [
    { key: 'mode', label: 'Processing', group: 'playback', type: 'choice', default: 'realtime',
      choices: [['realtime', 'Real-time'], ['everyFrame', 'Every frame']] },
    { key: 'view', label: 'View', group: 'view', type: 'choice', default: 'original',
      choices: [['original', 'Original'], ['stabilised', 'Stabilised'], ['points', 'Points'], ['diff', 'Raw diff'], ['mask', 'Mask']] },
    { key: 'showCandidates', label: 'Unconfirmed candidates', group: 'view', type: 'bool', default: true },
    { key: 'showTruth', label: 'Ground truth (synthetic)', group: 'view', type: 'bool', default: true },
    { key: 'showZones', label: 'Exclusion zones', group: 'view', type: 'bool', default: true },

    // detection (detect.js)
    { key: 'detectMode', label: 'Detection', group: 'detect', type: 'choice', default: 'robust',
      choices: [['robust', 'Robust (3 frames)'], ['basic', 'Basic (2 frames)']] },
    { key: 'procWidth', label: 'Processing width', group: 'detect', type: 'choice', default: '0',
      choices: [['0', 'Source'], ['1920', '1920'], ['1280', '1280'], ['960', '960'], ['640', '640']] },
    { key: 'stride', label: 'Frame stride', group: 'detect', type: 'number', default: 1, min: 1, max: 12, step: 1, unit: 'frames' },
    { key: 'threshold', label: 'Diff threshold', group: 'detect', type: 'number', default: 20, min: 5, max: 100, step: 1, unit: 'grey' },
    { key: 'minArea', label: 'Min blob area', group: 'detect', type: 'number', default: 1, min: 1, max: 50, step: 1, unit: 'px' },
    { key: 'maxArea', label: 'Max blob area', group: 'detect', type: 'number', default: 400, min: 10, max: 5000, step: 10, unit: 'px' },
    { key: 'borderMargin', label: 'Border margin', group: 'detect', type: 'number', default: 3, min: 0, max: 20, step: 1, unit: 'px' },
    { key: 'brightness', label: 'Match brightness', group: 'detect', type: 'bool', default: true },
    { key: 'blur', label: '3×3 blur', group: 'detect', type: 'bool', default: false },
    { key: 'open', label: '3×3 opening (drops 1–2 px blobs)', group: 'detect', type: 'bool', default: false },
    { key: 'zonesMotion', label: 'Also ignore zones for camera motion', group: 'zones', type: 'bool', default: true },

    // temporal confirmation (tracker.js)
    { key: 'confirmN', label: 'Confirm: seen in N', group: 'track', type: 'number', default: 3, min: 1, max: 10, step: 1, unit: 'frames' },
    { key: 'confirmM', label: '… of the last M', group: 'track', type: 'number', default: 5, min: 2, max: 10, step: 1, unit: 'frames' },
    { key: 'gateBase', label: 'Association gate', group: 'track', type: 'number', default: 4, min: 1, max: 30, step: 1, unit: 'px' },
    { key: 'maxSpeed', label: 'Max speed (new tracks)', group: 'track', type: 'number', default: 12, min: 2, max: 60, step: 1, unit: 'px/frame' },
    { key: 'minTravel', label: 'Min travel to confirm', group: 'track', type: 'number', default: 3, min: 0, max: 30, step: 1, unit: 'px' },

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

// Merges saved values and then hash values over the defaults.
export function resolveParams(saved, hash) {
    const p = defaults();
    for (const src of [saved || {}, hash || {}]) {
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
        const [k, v = ''] = part.split('=');
        out[decodeURIComponent(k)] = decodeURIComponent(v);
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
