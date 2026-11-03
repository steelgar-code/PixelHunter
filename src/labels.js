// Labels: the user's verdicts on a clip's objects (real / not an object), with each object's
// path over time, kept per clip and saved as a file (see dataStore.js). Pure apart from
// crypto.subtle for the clip id.
//
// A clip's labels (version 1):
//   { app, kind: 'labels', version, clip: { id, name, bytes, duration, width, height, fps },
//     complete: all real objects in the clip are labelled (unmatched tracks then count as false),
//     objects: [{ id, label: 'real' | 'not', source: 'tracked' | 'marked', size: [w, h], contrast,
//                 keys: [[t, x, y, w, h], …], crops: [names], created, changed }],
//     bookmarks: [{ frame, time }], changed }
// Positions and sizes in source-video px (pixel centres at integers), times in media seconds.
// A path is stored as keyframes: points that a straight line between their neighbours puts
// within SIMPLIFY_PX are dropped (1 px: tracked positions are box centres, whole or half pixels,
// so 0.5 px kept nearly every point of a straight path; matching allows ≥ 4 px anyway); between keyframes (and across gaps where the object wasn't
// seen) the path is interpolated linearly.

export const LABELS_VERSION = 1;
export const SIMPLIFY_PX = 1;            // position tolerance of the keyframes, px
const SIZE_TOL = 1;                      // size tolerance of the keyframes, px
const MAX_KEYS = 20000;                  // per object, after simplification (a safety cap)

const r1 = v => Math.round(v * 10) / 10;
const r3 = t => Math.round(t * 1000) / 1000;
const nowIso = () => new Date().toISOString();
const finite = (...v) => v.every(Number.isFinite);

// --- clip identity ---------------------------------------------------------------------------

async function sha256Hex(parts) {
    const enc = new TextEncoder();
    const bufs = parts.map(p => (typeof p === 'string' ? enc.encode(p) : p instanceof ArrayBuffer ? new Uint8Array(p) : p));
    const all = new Uint8Array(bufs.reduce((a, b) => a + b.length, 0));
    let o = 0;
    for (const b of bufs) { all.set(b, o); o += b.length; }
    const h = await crypto.subtle.digest('SHA-256', all);
    return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('');
}

const MB = 1 << 20;
// A file (Blob): SHA-256 of its first and last 1 MB and its size, so a renamed copy is the same clip.
export async function fileClipId(file) {
    const head = await file.slice(0, Math.min(file.size, MB)).arrayBuffer();
    const tail = await file.slice(Math.max(0, file.size - MB)).arrayBuffer();
    return sha256Hex(['file:', head, tail, `:${file.size}`]);
}
export const urlClipId = (url, duration, width, height) => sha256Hex([`url:${url}|${r3(duration)}|${width}x${height}`]);
export const sceneClipId = options => sha256Hex([`scene:${JSON.stringify(options)}`]);

// --- paths -------------------------------------------------------------------------------------

// Interpolated [x, y, w, h] at time t, or null outside the path's span (± slack s).
export function interpolate(keys, t, slack = 0) {
    if (!keys || !keys.length) return null;
    const n = keys.length;
    if (t < keys[0][0] - slack || t > keys[n - 1][0] + slack) return null;
    if (t <= keys[0][0]) return keys[0].slice(1);
    if (t >= keys[n - 1][0]) return keys[n - 1].slice(1);
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (keys[m][0] <= t) lo = m; else hi = m; }
    const a = keys[lo], b = keys[hi], f = b[0] > a[0] ? (t - a[0]) / (b[0] - a[0]) : 0;
    return [1, 2, 3, 4].map(i => a[i] + (b[i] - a[i]) * f);
}

export const spanOf = o => (o.keys && o.keys.length ? [o.keys[0][0], o.keys[o.keys.length - 1][0]] : null);

// Keyframes: drops points the line between their neighbours (in time) puts within `tol` px
// (and sizes within SIZE_TOL). Douglas–Peucker over time, iterative.
export function simplify(keys, tol = SIMPLIFY_PX) {
    if (keys.length <= 2) return keys.slice();
    const keep = new Uint8Array(keys.length);
    keep[0] = keep[keys.length - 1] = 1;
    const stack = [[0, keys.length - 1]];
    while (stack.length) {
        const [i, j] = stack.pop();
        if (j - i < 2) continue;
        const a = keys[i], b = keys[j];
        let worst = -1, at = -1;
        for (let k = i + 1; k < j; k++) {
            const p = keys[k];
            const f = b[0] > a[0] ? (p[0] - a[0]) / (b[0] - a[0]) : 0;
            const ix = a[1] + (b[1] - a[1]) * f, iy = a[2] + (b[2] - a[2]) * f;
            const iw = a[3] + (b[3] - a[3]) * f, ih = a[4] + (b[4] - a[4]) * f;
            const pos = Math.hypot(p[1] - ix, p[2] - iy);
            const size = Math.max(Math.abs(p[3] - iw), Math.abs(p[4] - ih));
            // how far over the tolerance (position or size), in units of it
            const over = Math.max(pos / tol, size / SIZE_TOL);
            if (over > worst) { worst = over; at = k; }
        }
        if (worst > 1) { keep[at] = 1; stack.push([i, at], [at, j]); }
    }
    const out = keys.filter((_, k) => keep[k]);
    return out.length > MAX_KEYS ? out.filter((_, k) => k % Math.ceil(out.length / MAX_KEYS) === 0) : out;
}

const cleanKey = k => (Array.isArray(k) && k.length >= 5 && finite(...k.slice(0, 5)) && k[3] > 0 && k[4] > 0
    ? [r3(k[0]), r1(k[1]), r1(k[2]), r1(k[3]), r1(k[4])] : null);

// Two lists of points merged in time order; at the same time (within 1 ms) `b`'s point wins.
export function mergeKeys(a, b) {
    const all = [...(a || []).map(k => [k, 0]), ...(b || []).map(k => [k, 1])].sort((x, y) => x[0][0] - y[0][0] || x[1] - y[1]);
    const out = [];
    for (const [k] of all) {
        const last = out[out.length - 1];
        if (last && Math.abs(last[0] - k[0]) < 0.0005) out[out.length - 1] = k; else out.push(k);
    }
    return out;
}

// Points of an object's history (objects.js rows, source px) where it was seen.
export function keysFromHistory(history) {
    const pts = [];
    for (const e of history || []) {
        if (e.event || !e.seen || !finite(e.time, e.x, e.y, e.w, e.h)) continue;
        pts.push(cleanKey([e.time, e.x, e.y, e.w, e.h]));
    }
    return mergeKeys([], pts.filter(Boolean));
}

// How close a tracked object must be to a label's path to be that object (also the
// benchmark's match radius): max(4 px, 1.5 × its size).
export const matchRadius = size => Math.max(4, 1.5 * Math.max(size[0] || 0, size[1] || 0));
// How close a click must be to extend an existing label (mark mode): max(6 px, 2 × its size).
export const extendRadius = size => Math.max(6, 2 * Math.max(size[0] || 0, size[1] || 0));

// --- a clip's labels -------------------------------------------------------------------------

export function newLabelSet(clip) {
    return { app: 'PixelHunter', kind: 'labels', version: LABELS_VERSION, clip: { ...clip }, complete: false, objects: [], bookmarks: [], changed: nowIso() };
}

export function newLabelId() {
    const a = new Uint8Array(6);
    crypto.getRandomValues(a);
    return [...a].map(b => b.toString(16).padStart(2, '0')).join('');
}

function normalizeObject(o) {
    if (!o || typeof o !== 'object' || !o.id || !['real', 'not'].includes(o.label)) return null;
    const keys = mergeKeys([], (Array.isArray(o.keys) ? o.keys : []).map(cleanKey).filter(Boolean));
    if (!keys.length) return null;
    const size = Array.isArray(o.size) && finite(o.size[0], o.size[1]) ? [r1(o.size[0]), r1(o.size[1])] : [keys[0][3], keys[0][4]];
    return { id: String(o.id).slice(0, 40), label: o.label, source: o.source === 'marked' ? 'marked' : 'tracked', size,
        contrast: Number.isFinite(o.contrast) ? r1(o.contrast) : null, keys,
        crops: Array.isArray(o.crops) ? o.crops.filter(c => typeof c === 'string' && /^[\w.-]+$/.test(c)).slice(0, 16) : [],
        created: String(o.created || nowIso()), changed: String(o.changed || o.created || nowIso()) };
}

// A labels file cleaned up, or null when it isn't one.
export function normalizeLabelSet(raw) {
    if (!raw || typeof raw !== 'object' || raw.kind !== 'labels' || !raw.clip || typeof raw.clip.id !== 'string' || !/^[0-9a-f]{16,64}$/.test(raw.clip.id)) return null;
    if (Number(raw.version) > LABELS_VERSION) return null;
    const c = raw.clip;
    const clip = { id: c.id, name: String(c.name || 'clip').slice(0, 200), bytes: Number.isFinite(c.bytes) ? c.bytes : null,
        duration: Number.isFinite(c.duration) ? c.duration : null, width: Number.isFinite(c.width) ? c.width : null,
        height: Number.isFinite(c.height) ? c.height : null, fps: Number.isFinite(c.fps) ? c.fps : null };
    const seen = new Set();
    const objects = (Array.isArray(raw.objects) ? raw.objects : []).map(normalizeObject).filter(o => o && !seen.has(o.id) && seen.add(o.id));
    const bookmarks = normalizeBookmarks(raw.bookmarks);
    return { app: 'PixelHunter', kind: 'labels', version: LABELS_VERSION, clip, complete: !!raw.complete, objects, bookmarks, changed: String(raw.changed || nowIso()) };
}

export function normalizeBookmarks(list) {
    const out = new Map();
    for (const b of Array.isArray(list) ? list : []) if (b && Number.isFinite(b.frame) && Number.isFinite(b.time)) out.set(b.frame, { frame: b.frame, time: r3(b.time) });
    return [...out.values()].sort((a, b) => a.frame - b.frame);
}

// Two versions of a clip's labels merged: per object the one changed last wins; bookmarks
// together; "complete" and the clip details from the newer set.
export function mergeLabelSets(a, b) {
    if (!a) return b;
    if (!b) return a;
    const newer = b.changed >= a.changed ? b : a;
    const byId = new Map(a.objects.map(o => [o.id, o]));
    for (const o of b.objects) { const x = byId.get(o.id); if (!x || o.changed >= x.changed) byId.set(o.id, o); }
    const clip = { ...a.clip, ...Object.fromEntries(Object.entries(newer.clip).filter(([, v]) => v !== null && v !== undefined)) };
    return { ...newer, clip, objects: [...byId.values()].sort((x, y) => x.created.localeCompare(y.created)),
        bookmarks: normalizeBookmarks([...a.bookmarks, ...b.bookmarks]), changed: newer.changed };
}

// Adds or updates an object's label: its keys merged with `keys` (newer points win) and
// simplified. Returns the label object.
export function upsertObject(set, { id, label, source = 'tracked', size, contrast, keys = [], crops }) {
    let o = set.objects.find(x => x.id === id);
    const t = nowIso();
    if (!o) {
        o = { id, label, source, size: size ? [r1(size[0]), r1(size[1])] : [4, 4], contrast: Number.isFinite(contrast) ? r1(contrast) : null,
            keys: [], crops: [], created: t, changed: t };
        set.objects.push(o);
    }
    if (label) o.label = label;
    if (size) o.size = [r1(size[0]), r1(size[1])];
    if (Number.isFinite(contrast)) o.contrast = r1(contrast);
    if (keys.length) o.keys = simplify(mergeKeys(o.keys, keys.map(cleanKey).filter(Boolean)));
    if (crops) o.crops = crops.slice(0, 16);
    o.changed = t;
    set.changed = t;
    return o;
}

export function removeObject(set, id) {
    const n = set.objects.length;
    set.objects = set.objects.filter(o => o.id !== id);
    if (set.objects.length !== n) set.changed = nowIso();
}

// Removes the point of `id` nearest in time to t (mark mode's undo); drops the object when
// none is left. Returns the object or null.
export function removeKeyAt(set, id, t) {
    const o = set.objects.find(x => x.id === id);
    if (!o) return null;
    let best = -1;
    o.keys.forEach((k, i) => { if (best < 0 || Math.abs(k[0] - t) < Math.abs(o.keys[best][0] - t)) best = i; });
    if (best >= 0) o.keys.splice(best, 1);
    o.changed = set.changed = nowIso();
    if (!o.keys.length) { removeObject(set, id); return null; }
    return o;
}

// The label whose path is nearest to (x, y) at time t, within radius(o) px; `slack` s beyond
// a path's ends still counts (its first / last position). Skips ids in `except`.
export function labelAt(set, t, x, y, { radius = o => matchRadius(o.size), slack = 0, except = null } = {}) {
    let best = null, bd = Infinity;
    for (const o of set ? set.objects : []) {
        if (except && except.has(o.id)) continue;
        const p = interpolate(o.keys, t, slack);
        if (!p) continue;
        const d = Math.hypot(p[0] - x, p[1] - y);
        if (d <= radius(o) && d < bd) { bd = d; best = o; }
    }
    return best;
}

export function counts(set) {
    const c = { real: 0, not: 0, marked: 0 };
    for (const o of set ? set.objects : []) { c[o.label]++; if (o.source === 'marked') c.marked++; }
    return c;
}

// Objects changed after `since` (ISO time, or null = all): not backed up yet.
export const changedSince = (set, since) => (set ? set.objects.filter(o => !since || o.changed > since).length : 0);

// File name in the data folder: the clip's name, its id (8 hex) to find it again after a rename.
export const id8 = clip => clip.id.slice(0, 8);
export function labelsFileName(clip) {
    const base = String(clip.name || 'clip').replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_').slice(0, 80) || 'clip';
    return `${base}.${id8(clip)}.labels.json`;
}
