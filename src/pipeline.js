// Per-frame processing. Detection compares frame t with frames t−s and t+s (s = stride,
// default 1), so frame t is processed when frame t+s arrives (s frames of latency).
// Everything here runs on a frame the caller gives it, so the same code can move into a worker
// later; the only DOM-ish thing is the canvas each frame is drawn into (an OffscreenCanvas
// where available).
//
// Ring buffer: 2s+1 slots of preallocated Mats (processing-resolution grey and a small grey
// copy for motion estimation), rotated by index and reallocated only when the size or the
// stride changes. Colour copies for display are kept for the last s+1 frames only. Camera
// motion is fitted between consecutive frames; H over s frames is the product of the
// per-frame fits.
//
// Camera motion is estimated on the small frames (estWidth) and scaled up to the processing
// resolution (procWidth, default the source's own), where detection runs so few-pixel objects
// survive. Coordinates in results are processing-resolution pixels; geometry.scale converts
// from source pixels. Exclusion zones (params.zones, fractions of the frame) are cleared from
// detection and, with zonesMotion, from camera-motion tracking. Inclusion zones
// (params.include) crop detection only: camera motion is always fitted on the whole frame.
//
// The slow lane (params.slow, slowLane.js): every few frames a second comparison of an older
// frame u with u ± n (n up to slowMax, as long as the camera's motion allows), with its own
// detector (the background-shift check on) and its own tracker; its tracks are carried to the
// displayed frame and shown with the rest (lane: 'slow'). While it is on, the ring holds
// 2 · slowMax + 1 frames. Off: nothing of it runs and the ring is 2s + 1, as before.

import { createEgomotion, EGO_DEFAULTS } from './egomotion.js';
import { createDetector, DETECT_DEFAULTS } from './detect.js';
import { createTracker, TRACK_DEFAULTS } from './tracker.js';
import { scaleH, mul, normalize, composeNewestFirst } from './homography.js';
import { mulberry32 } from './synth.js';
import { contrastOf } from './objects.js';
import { stackCrop, CROP } from './crops.js';
import { createSlowLane, ringFrames, slowDetectParams } from './slowLane.js';

export function makeCanvas(w, h) {
    if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
}

export const pick = (defaults, p) => Object.fromEntries(Object.keys(defaults).filter(k => k in p).map(k => [k, p[k]]));
// exclusion zones always apply to detection; to camera motion unless zonesMotion is off
// (precise / thinFit off: the fit as it was before 0.12.0, from every point that agrees with it)
export const egoParams = p => ({ ...pick(EGO_DEFAULTS, p), zones: p.zonesMotion === false ? [] : p.zones || [],
    ...(p.precise === false ? { fbRel: 0 } : {}), ...(p.thinFit === false ? { loose: 0 } : {}) });
export const detectParams = p => ({ ...pick(DETECT_DEFAULTS, p), zones: p.zones || [], include: p.include || [] });
export const trackParams = p => pick(TRACK_DEFAULTS, p);
export const laneParams = p => ({ slow: !!p.slow, slowMax: p.slowMax, slowBudget: p.slowBudget, slowTop: p.slowTop, travelFit: p.slowTravelFit, travelFactor: p.slowTravel, sparse: p.slowSparse, pathFactor: p.slowPath, topSlack: p.slowTopSlack, keepMoving: p.slowKeepMoving, speedPerSize: p.slowPerSize, fitCarry: p.slowFitCarry, track: trackParams(p) });
// a candidate's strength (confirmation by evidence) and, for min contrast to confirm, its contrast
// against its surroundings in its own frame
export function prepareBlobs(detect, grey, p) {
    const blobs = detect.weak && detect.weak.length ? [...detect.candidates, ...detect.weak] : detect.candidates;
    for (const b of blobs) if (b.score !== undefined) b.strength = b.score / p.sigmas;
    if (p.minSpatial > 0) for (const b of blobs) b.spatial = contrastOf(grey, b);
    return blobs;
}
// the slow lane's tracks joined to the fast lane's in a result: { tracks, confirmed, held }
export function joinLanes(fast, slow) {
    const tracks = slow.length ? [...(fast || []), ...slow] : fast || [];
    return { tracks, confirmed: fast || slow.length ? tracks.filter(t => t.state === 'confirmed' && t.matched) : [],
        held: fast || slow.length ? tracks.filter(t => t.state === 'held') : [] };
}
// what the stats and tests see of the lane: state, n, cadence, candidates (on a pass), reason
export const slowSummary = (lane, d, ms) => ({ ...lane.stats, ms, ...(d ? { list: d.ok ? d.candidates : [] } : {}) });

// How good a camera-motion fit is, at processing resolution: 90 % of the points it is made of are
// within err90 px of where it puts them (the detector's allowance follows it); misfit: how far
// the picture is from it in places; coverage: share of grid cells it holds; corner: how
// well those points pin it down at the frame's corners (px, 1 σ); model: 'similarity' when they
// didn't and the simpler fit was used; used: points it is made of.
export const fitOf = (e, geom) => (e && e.err90 !== undefined && e.err90 !== null
    ? { err50: e.err50 * geom.kx, err90: e.err90 * geom.kx, coverage: e.coverage, used: e.used ?? e.inliers,
        misfit: (e.misfit ?? e.err90) * geom.kx, corner: Number.isFinite(e.cornerStd) ? e.cornerStd * geom.kx : null, model: e.model || 'homography' } : null);

// The misalignment a fit leaves, for the detector's allowance (small-frame px): the scatter of its
// points (err90), as the allowance was tuned. fitErrFrom 'misfit' (an option to measure, not in
// the settings): what the fit gets wrong in places, which leaves out how precisely each point was
// followed; with it the allowance needs a higher floor (tolBase ~0.10), see the benchmark's
// mid+misfit.
export const fitErrOf = (e, p) => (p.fitErrFrom === 'misfit' ? e.misfit ?? e.err90 : e.err90) ?? 0.15;

export const MAX_STRIDE = 12;
// where confirmed objects are expected, as the detector's nearMargin takes them
// source frames between the slots b + 1 and b of a history (at): 1 + the frames dropped in
// between, never more than the time between them allows at MAX_FPS (as the fast lane's dt)
export const framesOf = at => b => {
    const m = at(b).meta, q = at(b + 1).meta;
    let d = ((m && m.gap) || 0) + 1;
    if (q && Number.isFinite(q.time) && Number.isFinite(m.time) && m.time > q.time) d = Math.min(d, Math.max(1, Math.round((m.time - q.time) * MAX_FPS)));
    return d;
};
export const nearList = list => list.map(t => ({ x: t.x, y: t.y, r: Math.min(NEAR_MAX_R, Math.max(4, t.gate)) }));
export const MAX_FPS = 120;             // highest source frame rate assumed when checking frame gaps
export const NEAR_MISSES = 3;           // nearMargin: around confirmed tracks missed up to this many frames
export const NEAR_MAX_R = 12;           // px: … within this of where they are expected (at most)

export function createPipeline(cv, params) {
    let p = { ...params };
    const ego = createEgomotion(cv, egoParams(p));
    const detector = createDetector(cv, detectParams(p));
    const tracker = createTracker(trackParams(p));
    const lane = createSlowLane(laneParams(p));
    let slowDet = null;          // the slow lane's detector (made when first needed)
    let geom = null;             // { srcW, srcH, w, h (processing), scale, sw, sh, kx, ky, stride }
    let slots = [];              // 2s+1: { grey, small, meta, egoIn, view }
    let views = [];              // s+1 colour canvases for display
    let rgba = null;             // shared RGBA Mat for grabbing
    let head = -1;               // index of the newest slot
    let count = 0;               // frames pushed since the last reset (capped at the slot count)
    let idx = -1;                // index of the newest frame since the last reset (slow lane)
    let pushed = 0;              // frames pushed overall (picks the display canvas)
    let tmpCanvas = null;        // ImageData sources at a different processing size
    let resetCause = 'start';    // why the frame history last started over (shown while it refills)
    const scratch = {};          // Mats for debug views, made on first use
    let viewData = null;         // ImageData for grey views
    let stack = null;            // frames t−s, t, t+s and the fits between them, for crops (until the next push)

    const stride = () => Math.min(MAX_STRIDE, Math.max(1, Math.round(Number(p.stride) || 1)));
    // slot holding the frame `back` frames before the newest
    const at = back => slots[(head - back + slots.length * 2) % slots.length];

    function freeAll() {
        for (const s of slots) { s.grey.delete(); s.small.delete(); }
        slots = [];
        views = [];
        if (rgba) rgba.delete();
        rgba = null;
        stack = null;
    }

    function setup(srcW, srcH, cause = 'start') {
        freeAll();
        resetCause = cause;
        const pw = Number(p.procWidth) > 0 ? Math.min(srcW, Number(p.procWidth)) : srcW;
        const w = pw, h = Math.max(1, Math.round(srcH * pw / srcW));
        const sw = Math.min(w, Math.round(p.estWidth)), sh = Math.max(1, Math.round(h * sw / w));
        const s = stride();
        geom = { srcW, srcH, w, h, scale: w / srcW, sw, sh, kx: w / sw, ky: h / sh, stride: s, ring: ringFrames(s, p) };
        tmpCanvas = null;
        rgba = new cv.Mat(h, w, cv.CV_8UC4);
        for (let i = 0; i < geom.ring; i++) {
            slots.push({ grey: new cv.Mat(h, w, cv.CV_8UC1), small: new cv.Mat(sh, sw, cv.CV_8UC1), meta: null, egoIn: null, view: null });
        }
        for (let i = 0; i < s + 1; i++) {
            const canvas = makeCanvas(w, h);
            views.push({ canvas, ctx: canvas.getContext('2d', { willReadFrequently: true }) });
        }
        for (const m of Object.values(scratch)) m.delete();
        for (const k of Object.keys(scratch)) delete scratch[k];
        viewData = null;
        head = -1;
        count = 0;
        idx = -1;
        ego.reset();
        tracker.reset();
        lane.reset();
    }

    function grab(slot, f) {
        const { ctx } = slot.view;
        if (f.imageData && geom.scale === 1) {
            ctx.putImageData(f.imageData, 0, 0);
        } else if (f.imageData) {
            tmpCanvas ??= makeCanvas(geom.srcW, geom.srcH);
            tmpCanvas.getContext('2d').putImageData(f.imageData, 0, 0);
            ctx.drawImage(tmpCanvas, 0, 0, geom.w, geom.h);
        } else {
            ctx.drawImage(f.image, 0, 0, geom.w, geom.h);
        }
        const id = ctx.getImageData(0, 0, geom.w, geom.h);
        rgba.data.set(id.data);
        cv.cvtColor(rgba, slot.grey, cv.COLOR_RGBA2GRAY);
        cv.resize(slot.grey, slot.small, new cv.Size(geom.sw, geom.sh), 0, 0, cv.INTER_AREA);
    }

    // Product of the per-frame fits from `back + n` frames before the newest to `back` frames
    // before it: { H (processing px), Hs (small px) }, or a reason when one is missing.
    // Slot `back + j` holds H(frame back+j+1 → frame back+j), so walking i upwards lists the fits
    // newest first.
    function chain(back, n) {
        const fits = [];
        for (let i = back; i < back + n; i++) {
            const e = at(i).egoIn;
            if (!e || !e.ok) return { reason: e ? `camera motion: ${e.reason}` : `no previous frame${restarted()}` };
            fits.push(e);
        }
        // error of the composition (processing px): the worst step's 90th-percentile error, growing
        // with the square root of the number of steps
        const err = Math.max(...fits.map(e => fitErrOf(e, p) * geom.kx)) * Math.sqrt(n);
        return { H: normalize(composeNewestFirst(fits.map(e => e.Hfull))), Hs: normalize(composeNewestFirst(fits.map(e => e.H))), err };
    }

    // f: { image (CanvasImageSource) or imageData, width, height, time, frame, seq, gap, jump, truth? }
    // Returns { slot: the frame to show (.view.canvas, .meta), result: frame t's result or null }.
    function push(f) {
        const t0 = performance.now();
        stack = null;
        if (!geom) setup(f.width, f.height);
        else if (geom.srcW !== f.width || geom.srcH !== f.height) setup(f.width, f.height, `video size changed to ${f.width}×${f.height}`);
        else if (geom.stride !== stride()) setup(f.width, f.height, 'frame stride changed');
        else if (geom.ring !== ringFrames(stride(), p)) setup(f.width, f.height, 'slow lane changed');
        const s = geom.stride;
        if (f.jump) {
            resetCause = f.jumpReason || (f.seq === 0 ? 'start' : 'seek');
            count = 0;
            idx = -1;
            ego.reset();
            tracker.reset();
            lane.reset();
        }
        head = (head + 1) % slots.length;
        const slot = slots[head];
        slot.meta = { seq: f.seq, frame: f.frame, time: f.time, gap: f.gap, jump: f.jump, truth: f.truth };
        slot.egoIn = null;
        slot.view = views[pushed++ % views.length];
        grab(slot, f);
        count = Math.min(count + 1, slots.length);
        idx++;
        const t1 = performance.now();
        if (count >= 2) {
            const e = ego.update(at(1).small, slot.small);
            if (e.H) e.Hfull = jitter(scaleH(e.H, geom.kx, geom.ky), f.seq);
            slot.egoIn = e;
        }
        const t2 = performance.now();
        // until frame t+s is in, show the first frame since the reset
        if (count < s + 1) return { slot: at(count - 1), result: null };

        const cur = at(s);
        const egoPrev = count >= s + 2 ? cur.egoIn : null;
        // frames since the previous one processed: never more than the time between them allows
        // at MAX_FPS, so a wrong frame-duration estimate can't widen the tracker's gates (which
        // grow with it) over half the frame
        let dt = (cur.meta.gap || 0) + 1;
        const prevT = count >= s + 2 ? at(s + 1).meta?.time : null;
        if (Number.isFinite(prevT) && Number.isFinite(cur.meta.time) && cur.meta.time > prevT) dt = Math.min(dt, Math.max(1, Math.round((cur.meta.time - prevT) * MAX_FPS)));
        let detect;
        stack = { cur: cur.grey, prev: null, next: null, Hb: null, Hf: null };
        if (count < 2 * s + 1) {
            detect = { ok: false, reason: (count === s + 1 ? 'no previous frame' : `waiting for ${s} frames before`) + restarted(), candidates: [] };
        } else {
            const back = chain(s, s);         // t−s → t
            const fwd = chain(0, s);          // t → t+s
            if (!back.H) detect = { ok: false, reason: back.reason, candidates: [] };
            else if (!fwd.H && p.detectMode !== 'basic') detect = { ok: false, reason: fwd.reason, candidates: [] };
            else {
                const prev = at(2 * s), next = slot;
                stack = { cur: cur.grey, prev: prev.grey, next: next.grey, Hb: back.H, Hf: fwd.H || null };
                // where the objects the user keeps tracking should be in frame t: the
                // background-shift check must not drop them
                const tracked = p.shiftCheck && egoPrev && egoPrev.ok
                    ? tracker.predict(egoPrev.Hfull, dt, { onlyPinned: true }).map(t => ({ x: t.x, y: t.y }))
                    : [];
                // where confirmed objects should be (also missed for a few frames): a lower
                // threshold around them (nearMargin)
                const near = p.nearMargin > 0 && egoPrev && egoPrev.ok ? nearList(tracker.predict(egoPrev.Hfull, dt, { maxMisses: NEAR_MISSES })) : [];
                detect = detector.detect({ prev: prev.grey, cur: cur.grey, next: next.grey, Hprev: back.H, Hnext: fwd.H || null,
                    fitErr: Math.max(back.err, fwd.err || 0), tracked, near,
                    small: { prev: prev.small, cur: cur.small, next: next.small, Hprev: back.Hs, Hnext: fwd.Hs || null } });
            }
        }
        // tracks: a step per frame with detections; without camera motion they coast
        let tracks = null;
        // weak candidates (adaptive mode) can only continue tracks, never start them
        const meta = { time: cur.meta.time, frame: cur.meta.frame };
        if (detect.ok) {
            const blobs = prepareBlobs(detect, cur.grey, p);
            tracks = tracker.step(blobs, egoPrev && egoPrev.ok ? egoPrev.Hfull : null, dt, meta);
        } else if (count >= 2 * s + 1) tracks = tracker.step([], null, dt, meta);
        const t3 = performance.now();
        // the slow lane: a pass on frame u = newest − n when one is due, then its tracks on frame t
        let slow = [], slowInfo = null;
        if (p.slow) {
            let d = null;
            const pl = lane.plan({ at, idx, count, s, geom, wantTracked: true, nearMargin: p.nearMargin, nearOf: nearList, frames: framesOf(at) });
            if (pl.pass) {
                const P = pl.pass, u = at(P.n), older = at(2 * P.n);
                slowDet ??= createDetector(cv, slowDetectParams(detectParams(p), p));
                d = slowDet.detect({ prev: older.grey, cur: u.grey, next: slot.grey, Hprev: P.Hprev, Hnext: P.Hnext, fitErr: P.fitErr,
                    tracked: P.tracked, near: P.near, small: { prev: older.small, cur: u.small, next: slot.small, Hprev: P.Hs.Hprev, Hnext: P.Hs.Hnext } });
                lane.step(P, d, d.ok ? prepareBlobs(d, u.grey, p) : null, idx, { time: u.meta.time, frame: u.meta.frame });
            }
            slow = lane.shown({ at, idx, count, s, geom, fast: tracks || [], frames: framesOf(at) });
            slowInfo = slowSummary(lane, d, performance.now() - t3);
        }
        const t4 = performance.now();
        const joined = joinLanes(tracks, slow);

        const result = {
            ...cur.meta,
            width: geom.w, height: geom.h, scale: geom.scale, stride: s,
            small: { w: geom.sw, h: geom.sh, kx: geom.kx, ky: geom.ky },
            egoPrev,                                          // t−1 → t
            fit: fitOf(egoPrev, geom),
            egoNext: at(s - 1).egoIn,                         // t → t+1
            detect,
            candidates: detect.candidates,
            tracks: joined.tracks,
            confirmed: joined.confirmed,
            held: joined.held,                                // stopped or lost, kept for a while
            ...(slowInfo ? { slow: slowInfo } : {}),
            timings: { grab: t1 - t0, ego: t2 - t1, detect: t3 - t2, ...(slowInfo ? { slow: t4 - t3 } : {}), total: t4 - t0 },
        };
        return { slot: cur, result };
    }

    // Test aid (hJitter > 0): a seeded random translation of up to ±hJitter px added to each
    // fitted H, to emulate registration error.
    function jitter(H, seq) {
        if (!(p.hJitter > 0)) return H;
        const r = mulberry32(seq * 2654435761);
        const dx = (r() * 2 - 1) * p.hJitter, dy = (r() * 2 - 1) * p.hJitter;
        return mul([1, 0, dx, 0, 1, dy, 0, 0, 1], H);
    }

    // ' (restarted: …)' after anything but the start of a source
    const restarted = () => (resetCause && resetCause !== 'start' ? ` (restarted: ${resetCause})` : '');

    function greyToCanvas(mat, ctx) {
        if (!viewData || viewData.width !== mat.cols || viewData.height !== mat.rows) viewData = new ImageData(mat.cols, mat.rows);
        const src = mat.data, dst = viewData.data;
        for (let i = 0, j = 0; i < src.length; i++, j += 4) {
            dst[j] = dst[j + 1] = dst[j + 2] = src[i];
            dst[j + 3] = 255;
        }
        ctx.putImageData(viewData, 0, 0);
    }

    // Draws the chosen view of the frame in `out.slot` (from the last push) into ctx.
    // Returns a note when the view can't be shown for this frame (then the original is drawn).
    function renderView(view, out, ctx) {
        const slot = out.slot;
        const r = out.result;
        if (view === 'stabilised') {
            if (!r || !r.egoPrev || !r.egoPrev.ok) {
                ctx.drawImage(slot.view.canvas, 0, 0);
                return r && r.egoPrev ? `no camera motion for this frame: ${r.egoPrev.reason}` : `no previous frame${restarted()}`;
            }
            const prev = at(geom.stride + 1);
            scratch.warped ??= new cv.Mat();
            scratch.blend ??= new cv.Mat();
            const M = cv.matFromArray(3, 3, cv.CV_64F, r.egoPrev.Hfull);
            cv.warpPerspective(prev.grey, scratch.warped, M, new cv.Size(geom.w, geom.h), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(0));
            M.delete();
            cv.addWeighted(slot.grey, 0.5, scratch.warped, 0.5, 0, scratch.blend);
            greyToCanvas(scratch.blend, ctx);
            return null;
        }
        if (view === 'diff' || view === 'mask') {
            if (!r || !r.detect.ok) {
                ctx.drawImage(slot.view.canvas, 0, 0);
                return r ? `no detection for this frame: ${r.detect.reason}` : `no previous frame${restarted()}`;
            }
            greyToCanvas(detector.viewMat(view), ctx);
            return null;
        }
        ctx.drawImage(slot.view.canvas, 0, 0);
        return null;
    }

    return {
        push,
        renderView,
        get geometry() { return geom; },
        get resetCause() { return resetCause; },
        setParams(next) {
            const cause = String(next.procWidth) !== String(p.procWidth) ? 'processing width changed'
                : next.estWidth !== p.estWidth ? 'estimation width changed' : null;
            p = { ...p, ...next };
            ego.setParams(egoParams(p));
            detector.setParams(detectParams(p));
            tracker.setParams(trackParams(p));
            lane.setParams(laneParams(p));
            if (slowDet) slowDet.setParams(slowDetectParams(detectParams(p), p));
            if (cause && geom) setup(geom.srcW, geom.srcH, cause);
        },
        // A 32×32 3-frame crop (crops.js) around (cx, cy) in the frame of the last result
        // (processing px), or null before there is one. Valid until the next push.
        crop(cx, cy, side = CROP) {
            if (!stack) return null;
            const g = m => (m ? { cols: m.cols, rows: m.rows, data: m.data } : null);
            return stackCrop({ cur: g(stack.cur), prev: g(stack.prev), next: g(stack.next), Hb: stack.Hb, Hf: stack.Hf }, cx, cy, side);
        },
        // ids of tracks to keep watching (pinned by the user)
        setPinned(ids) { tracker.setPinned(ids); lane.setPinned(ids); },
        reset(cause = 'reset') { resetCause = cause; count = 0; idx = -1; stack = null; ego.reset(); tracker.reset(); lane.reset(); },
        dispose() {
            freeAll();
            for (const m of Object.values(scratch)) m.delete();
            ego.dispose();
            detector.dispose();
            if (slowDet) slowDet.dispose();
        },
    };
}
