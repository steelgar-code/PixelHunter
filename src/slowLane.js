// The slow lane: a second comparison over a longer time, for objects slower than about 2 px a
// frame against the ground (the fast lane, t ± s, cannot see them: they cancel against themselves).
// Pure: no DOM, no OpenCV; both engines (pipeline.js, workerPipeline.js) run it the same way and
// only the detector call differs (on the page, or the same `detect` message to the workers).
//
//   Where in time   the display stays at t = newest − s. The lane works on an older frame
//                   u = newest − n and compares it with u − n and u + n (= the newest frame).
//   How long (n)    from the fits of the last frames: the largest n ≤ slowMax for which the
//                   picture moved no more than slowBudget px (frame corners and centre,
//                   processing px) between frame u and any frame of the 2n compared; no pass
//                   when n ≤ s or a fit in that span is missing; u never goes back between passes.
//   How often       a pass every c = max(2, ⌈n / 3⌉) frames; while the camera moves too much the
//                   lane rests ("camera moving") and tries again on the next frame.
//   H over n frames the product of the per-frame fits (as for the fast lane). The detector's
//                   allowance: the fits' misfit × √n (not the points' scatter × √n, which would
//                   reach the maximum at n = 12 for no reason), with tolBase SLOW_TOL_BASE; the
//                   background-shift check is always on here (depth and sway grow with n).
//   Tracking        a tracker of its own (ids from SLOW_ID_BASE), stepped once per pass with the
//                   frames since its last pass as dt and carried by the fits in between. New
//                   tracks only up to SLOW_TOP px a frame (faster ones are the fast lane's: the
//                   gate for a second sighting, and tracks faster than SLOW_TOP dropped); hold
//                   time and the time window of "N within T s" scaled to passes; the other
//                   confirmation settings are the user's. Between passes its tracks are carried
//                   to the displayed frame with the fits plus their own velocity, shown where
//                   expected, and count as seen if the last pass saw them.
//   Candidates      large ragged ones (box ≥ 48 px², under 45 % filled) are dropped: moved edges.
//   One track       a slow track at the same place on the displayed frame as a confirmed fast
//                   track, with a similar velocity, is hidden while that lasts (the fast one stays).
//
// The screen-fixed guard of the lane's tracker (tracker.js fixedMinMove) only applies when the
// background itself moved ≥ SLOW_FIXED_MOVE px on the screen during the sightings: on a fixed
// camera a slow object stays within the guard's 1.5 px for 8 sightings. (The fast lane's guard is
// unchanged: an object the fast lane sees moves ≥ 2 px a frame and never stays within 1.5 px.)

import { createTracker } from './tracker.js';
import { project, mul, normalize, composeNewestFirst, IDENTITY } from './homography.js';

export const SLOW_MAX = 12;            // frames: the longest comparison the ring can hold
export const SLOW_TOP = 2;             // px a frame: fastest track the lane starts and keeps …
export const SLOW_PER_SIZE = 0.5;      // … or half the object's box length a frame, if more (larger objects
                                       // moving less than about half their length a frame are in neither lane otherwise)
const SLOW_TOP_SLACK = 0;              // … plus this (0.5 let the sky targets of W, 3 px a frame, in at the
                                       // gimbal's turnarounds, shown off target: 5 false tracks a minute; 0: none)
export const SLOW_TOL_BASE = 0.10;     // detector's tolBase in this lane
export const SLOW_ID_BASE = 1000000;   // the lane's track ids start here
export const SLOW_FIXED_MOVE = 3;      // px the background must move for the screen-fixed guard
// a candidate whose box is at least SPARSE_BOX px² and less than this share filled is a moved edge
// (a branch's rim at the end of its sway), not an object: dropped. Measured on the tree scenes,
// four seeds, false tracks a minute (tripod · hovering): off 25 · 25, 0.3: 3.8 · 3.8, 0.45: 2.5 · 0;
// recall of the slow scenes unchanged. Objects this lane sees have moved off themselves and show
// whole (a 3×8 person, an 8×4 vehicle: under SPARSE_BOX anyway)
export const SLOW_SPARSE = 0.45;
const SPARSE_BOX = 48;
// Limit: a thin object across the box's diagonal (2 px wide, 14 long, at 45°: 15×15 box, ~28 px
// set, 12 %) is dropped too; a compact or L-shaped one (a person with its shadow) is kept.
export const ragged = (b, sparse = SLOW_SPARSE) => sparse > 0 && b.w * b.h >= SPARSE_BOX && b.area < sparse * b.w * b.h;
const SAME_PLACE = 6;                  // px: a slow track this close to a fast one (or within its gate) …
const SAME_SPEED = 1;                  // … with a velocity this close (px a frame, or half the fast one's speed) is the same object

export const slowMaxOf = p => Math.min(SLOW_MAX, Math.max(2, Math.round(Number(p.slowMax) || SLOW_MAX)));
// frames the history holds: 2s + 1, or 2 · slowMax + 1 while the lane is on
export const ringFrames = (s, p) => 2 * (p.slow ? Math.max(s, slowMaxOf(p)) : s) + 1;
export const cadenceOf = n => Math.max(2, Math.ceil(n / 3));
export const SLOW_SHIFT = 4;           // px: the background-shift check's largest shift in this lane (at least):
                                       // a branch swaying 2.5 px shifts up to 5 px over ±12 frames (2 → 4: tree false tracks 60 → 18 a minute)
// the detector's settings in this lane: dp the fast lane's (pipeline.js detectParams), p all
// settings (slowTolBase, slowShift: options to measure, not in the settings)
// (and the border margin along the frame's own edges: detect.js edgeMargin)
export const slowDetectParams = (dp, p = {}) => ({ ...dp, shiftCheck: true, tolBase: p.slowTolBase ?? SLOW_TOL_BASE,
    shiftMax: Math.max(dp.shiftMax ?? 2, p.slowShift ?? SLOW_SHIFT), edgeMargin: true });

// Product of the fits from `back + n` frames before the newest to `back` frames before it, as
// pipeline.js chain(), with the error from the fits' misfit (processing px) × √n.
// at(b): the slot b frames before the newest ({ egoIn: { ok, H, Hfull, misfit, err90 } }).
export function laneChain(at, back, n, kx) {
    if (n === 0) return { H: IDENTITY.slice(), Hs: IDENTITY.slice(), err: 0 };
    const fits = [];
    for (let i = back; i < back + n; i++) {
        const e = at(i).egoIn;
        if (!e || !e.ok) return { reason: e ? `camera motion: ${e.reason}` : 'no camera motion' };
        fits.push(e);
    }
    const err = Math.max(...fits.map(e => (e.misfit ?? e.err90 ?? 0.15) * kx)) * Math.sqrt(n);
    return { H: normalize(composeNewestFirst(fits.map(e => e.Hfull))), Hs: normalize(composeNewestFirst(fits.map(e => e.H))), err };
}

// The longest comparison the camera's motion allows now: { n } or { reason }.
// count: frames in the history; lastBack: how many frames before the newest the last pass's u
// lies (null: no pass yet); w, h: processing px.
export function chooseN({ at, count, s, max, budget, w, h, lastBack }) {
    const pts = [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1], [(w - 1) / 2, (h - 1) / 2]];
    const moved = M => Math.max(...pts.map(([x, y]) => { const [a, b] = project(M, x, y); return Math.hypot(a - x, b - y); }));
    if (max <= s) return { reason: 'frame stride not shorter than the longest comparison' };
    let reason = null;
    for (let n = max; n > s; n--) {
        if (2 * n + 1 > count) { reason ??= 'waiting for frames'; continue; }
        if (lastBack !== null && n >= lastBack) { reason ??= 'waiting for frames'; continue; }
        let ok = true;
        for (let b = 0; b < 2 * n; b++) { const e = at(b).egoIn; if (!e || !e.ok) { ok = false; break; } }
        if (!ok) { reason = reason === 'camera moving' ? reason : 'no camera motion for some frames'; continue; }
        // frame u (n frames back) into each newer frame: H(u → b) = fit(b) · … · fit(n − 1)
        let worst = 0, Hn = IDENTITY.slice(), Ho = IDENTITY.slice();
        for (let b = n - 1; b >= 0 && worst <= budget; b--) { Hn = mul(at(b).egoIn.Hfull, Hn); worst = Math.max(worst, moved(Hn)); }
        // each older frame into u: H(b + 1 → u) = fit(n) · … · fit(b)
        for (let b = n; b < 2 * n && worst <= budget; b++) { Ho = mul(Ho, at(b).egoIn.Hfull); worst = Math.max(worst, moved(Ho)); }
        if (worst <= budget) return { n };
        reason = 'camera moving';
    }
    return { reason: reason || 'camera moving' };
}

// A slow track (tracker snapshot in frame u) carried k frames on to the displayed frame with H
// (u → displayed) and its own velocity.
function carryShown(t, H, k) {
    const [x, y] = project(H, t.x, t.y);
    const [ex, ey] = project(H, t.x + t.vx, t.y + t.vy);
    const vx = ex - x, vy = ey - y;
    const mx = t.held ? 0 : vx * k, my = t.held ? 0 : vy * k;
    let box = t.box;
    if (box) {
        const [bx, by] = project(H, box.cx, box.cy);
        box = { ...box, x: box.x + bx + mx - box.cx, y: box.y + by + my - box.cy, cx: bx + mx, cy: by + my };
    }
    const [lx, ly] = project(H, t.lastSeen[0], t.lastSeen[1]);
    return { ...t, x: x + mx, y: y + my, vx, vy, box, trail: t.trail.map(([a, b]) => project(H, a, b)), lastSeen: [lx, ly],
        predicted: [x + mx, y + my], lane: 'slow' };
}

// source frames from slot `to` (older) to slot `from` (newer)
const framesIn = (frames, from, to) => { let d = 0; for (let b = from; b < to; b++) d += frames(b); return d; };

export function createSlowLane(params = {}) {
    let p = { ...params };
    const tracker = createTracker({ firstId: SLOW_ID_BASE });
    let lastU = null;          // frame index (since the reset) of the last pass's u
    let lastPass = null;       // … of the newest frame at the last pass
    let lastN = null;
    let snap = [];             // the tracker's tracks after the last pass (frame u)
    let fresh = false;         // the last pass's tracks not shown yet (hand `early` out once)
    let stats = { state: 'off' };

    function trackerParams(c) {
        return { ...p.track, maxSpeed: p.slowTop ?? SLOW_TOP, holdFrames: Math.ceil((p.track.holdFrames ?? 50) / c),
            confirmSecs: (p.track.confirmSecs ?? 0.2) * c, fixedMinMove: SLOW_FIXED_MOVE, travelFit: p.travelFit ?? true,
            maxTrackSpeed: (p.slowTop ?? SLOW_TOP) + (p.topSlack ?? SLOW_TOP_SLACK), keepMoving: p.keepMoving ?? true, speedPerSize: p.speedPerSize ?? SLOW_PER_SIZE,
            minTravel: (p.track.minTravel ?? 3) * (p.travelFactor ?? 1), pathTolerance: (p.track.pathTolerance ?? 1.5) * (p.pathFactor ?? 1) };
    }

    function reset() {
        tracker.reset();
        lastU = lastPass = lastN = null;
        snap = [];
        fresh = false;
        stats = { state: p.slow ? 'waiting' : 'off', reason: 'waiting for frames' };
    }

    return {
        get tracker() { return tracker; },
        get stats() { return stats; },
        // p: { slow, slowMax, slowBudget, slowTop?, track: tracker settings (trackParams) }
        setParams(next) { p = { ...p, ...next }; },
        setPinned(ids) { tracker.setPinned(ids); },
        reset,

        // Whether to make a pass now, and with what: { pass: { n, back: u's slot, Hprev, Hnext,
        // Hs, fitErr, H (last u → u) , dt, tracked, near } } or { rest: reason }.
        // idx: index of the newest frame since the reset; count: frames in the history;
        // geom: { w, h, kx }; opts: { tracked, near } as the fast lane computes them.
        // frames(b): source frames between the slots b + 1 and b (more than 1 where real time
        // dropped frames: velocities, dt and the lane's speed limit are per source frame).
        plan({ at, idx, count, s, geom, wantTracked = false, nearMargin = 0, nearOf = null, frames = () => 1 }) {
            if (!p.slow) { stats = { state: 'off' }; return { rest: 'off' }; }
            if (lastPass !== null && idx - lastPass < cadenceOf(lastN)) {
                stats = { ...stats, state: 'between', candidates: stats.candidates };
                return { rest: 'between passes' };
            }
            let lastBack = lastU === null ? null : idx - lastU;
            // the last pass's frame has left the history (the lane rested too long): start over
            if (lastBack !== null && lastBack > count - 1) { reset(); lastBack = null; }
            const ch = chooseN({ at, count, s, max: slowMaxOf(p), budget: Number(p.slowBudget) || 0, w: geom.w, h: geom.h, lastBack });
            if (!ch.n) { stats = { state: 'resting', reason: ch.reason }; return { rest: ch.reason }; }
            const n = ch.n;
            const back = laneChain(at, n, n, geom.kx), fwd = laneChain(at, 0, n, geom.kx);
            // the tracker is carried from the last pass's u to this one's
            let H = null, dt = 1;
            if (lastBack !== null) {
                const c = laneChain(at, n, lastBack - n, geom.kx);
                if (c.H) { H = c.H; dt = framesIn(frames, n, lastBack); } else { tracker.reset(); snap = []; }
            }
            if (!H) H = IDENTITY.slice();
            const tracked = wantTracked ? tracker.predict(H, dt, { onlyPinned: true }).map(t => ({ x: t.x, y: t.y })) : [];
            const near = nearMargin > 0 && nearOf ? nearOf(tracker.predict(H, dt, { maxMisses: 3 })) : [];
            return { pass: { n, back: n, Hprev: back.H, Hnext: fwd.H, Hs: { Hprev: back.Hs, Hnext: fwd.Hs }, fitErr: Math.max(back.err, fwd.err), H, dt, tracked, near } };
        },

        // After the pass's detection: one tracker step on frame u. blobs: candidates and weak
        // ones (with strength / spatial set as the fast lane does), or null when detection failed.
        step(plan, detect, blobs, idx, meta) {
            const c = cadenceOf(plan.n);
            tracker.setParams(trackerParams(c));
            // a moved edge, not an object: large and ragged (the lane sees objects whole: they have
            // moved off themselves over n frames)
            const sparse = p.sparse ?? SLOW_SPARSE;
            if (blobs && sparse > 0) blobs = blobs.filter(b => !ragged(b, sparse));
            snap = detect.ok ? tracker.step(blobs, plan.H, plan.dt, meta) : tracker.step([], null, plan.dt, meta);
            fresh = true;
            lastU = idx - plan.n;
            lastPass = idx;
            lastN = plan.n;
            stats = { state: 'pass', n: plan.n, cadence: c, frame: meta.frame, candidates: detect.ok ? detect.candidates.length : null, reason: detect.ok ? null : detect.reason };
        },

        // The lane's tracks on the displayed frame (s frames before the newest): carried there,
        // without those a confirmed fast track already follows. fast: the fast lane's tracks.
        shown({ at, idx, count, s, geom, fast, frames = () => 1 }) {
            if (!p.slow || lastU === null || !snap.length) return [];
            const lastBack = idx - lastU, k = lastBack - s;
            if (lastBack > count - 1) { reset(); return []; }
            const kf = k > 0 ? framesIn(frames, s, lastBack) : 0;
            const c = k > 0 ? laneChain(at, s, k, geom.kx) : { H: IDENTITY.slice() };
            if (!c.H) return [];
            const fastConf = fast.filter(f => f.state === 'confirmed');
            const out = [];
            for (const t of snap) {
                const q = carryShown(t, c.H, kf);
                const same = fastConf.some(f => Math.hypot(f.x - q.x, f.y - q.y) <= Math.max(SAME_PLACE, f.gate || 0)
                    && Math.hypot(f.vx - q.vx, f.vy - q.vy) <= Math.max(SAME_SPEED, 0.5 * Math.hypot(f.vx, f.vy)));
                if (same) continue;
                if (!fresh) delete q.early;
                out.push(q);
            }
            fresh = false;
            if (stats.state !== 'off') stats = { ...stats, shown: out.length };
            return out;
        },
    };
}
