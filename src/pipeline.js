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

import { createEgomotion, EGO_DEFAULTS } from './egomotion.js';
import { createDetector, DETECT_DEFAULTS } from './detect.js';
import { createTracker, TRACK_DEFAULTS } from './tracker.js';
import { scaleH, mul, normalize, composeNewestFirst } from './homography.js';
import { mulberry32 } from './synth.js';

function makeCanvas(w, h) {
    if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
}

const pick = (defaults, p) => Object.fromEntries(Object.keys(defaults).filter(k => k in p).map(k => [k, p[k]]));
// exclusion zones always apply to detection; to camera motion unless zonesMotion is off
const egoParams = p => ({ ...pick(EGO_DEFAULTS, p), zones: p.zonesMotion === false ? [] : p.zones || [] });
const detectParams = p => ({ ...pick(DETECT_DEFAULTS, p), zones: p.zones || [], include: p.include || [] });
const trackParams = p => pick(TRACK_DEFAULTS, p);

export const MAX_STRIDE = 12;

export function createPipeline(cv, params) {
    let p = { ...params };
    const ego = createEgomotion(cv, egoParams(p));
    const detector = createDetector(cv, detectParams(p));
    const tracker = createTracker(trackParams(p));
    let geom = null;             // { srcW, srcH, w, h (processing), scale, sw, sh, kx, ky, stride }
    let slots = [];              // 2s+1: { grey, small, meta, egoIn, view }
    let views = [];              // s+1 colour canvases for display
    let rgba = null;             // shared RGBA Mat for grabbing
    let head = -1;               // index of the newest slot
    let count = 0;               // frames pushed since the last reset (capped at the slot count)
    let pushed = 0;              // frames pushed overall (picks the display canvas)
    let tmpCanvas = null;        // ImageData sources at a different processing size
    let resetCause = 'start';    // why the frame history last started over (shown while it refills)
    const scratch = {};          // Mats for debug views, made on first use
    let viewData = null;         // ImageData for grey views

    const stride = () => Math.min(MAX_STRIDE, Math.max(1, Math.round(Number(p.stride) || 1)));
    // slot holding the frame `back` frames before the newest
    const at = back => slots[(head - back + slots.length * 2) % slots.length];

    function freeAll() {
        for (const s of slots) { s.grey.delete(); s.small.delete(); }
        slots = [];
        views = [];
        if (rgba) rgba.delete();
        rgba = null;
    }

    function setup(srcW, srcH, cause = 'start') {
        freeAll();
        resetCause = cause;
        const pw = Number(p.procWidth) > 0 ? Math.min(srcW, Number(p.procWidth)) : srcW;
        const w = pw, h = Math.max(1, Math.round(srcH * pw / srcW));
        const sw = Math.min(w, Math.round(p.estWidth)), sh = Math.max(1, Math.round(h * sw / w));
        const s = stride();
        geom = { srcW, srcH, w, h, scale: w / srcW, sw, sh, kx: w / sw, ky: h / sh, stride: s };
        tmpCanvas = null;
        rgba = new cv.Mat(h, w, cv.CV_8UC4);
        for (let i = 0; i < 2 * s + 1; i++) {
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
        ego.reset();
        tracker.reset();
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
        return { H: normalize(composeNewestFirst(fits.map(e => e.Hfull))), Hs: normalize(composeNewestFirst(fits.map(e => e.H))) };
    }

    // f: { image (CanvasImageSource) or imageData, width, height, time, frame, seq, gap, jump, truth? }
    // Returns { slot: the frame to show (.view.canvas, .meta), result: frame t's result or null }.
    function push(f) {
        const t0 = performance.now();
        if (!geom) setup(f.width, f.height);
        else if (geom.srcW !== f.width || geom.srcH !== f.height) setup(f.width, f.height, `video size changed to ${f.width}×${f.height}`);
        else if (geom.stride !== stride()) setup(f.width, f.height, 'frame stride changed');
        const s = geom.stride;
        if (f.jump) {
            resetCause = f.jumpReason || (f.seq === 0 ? 'start' : 'seek');
            count = 0;
            ego.reset();
            tracker.reset();
        }
        head = (head + 1) % slots.length;
        const slot = slots[head];
        slot.meta = { seq: f.seq, frame: f.frame, time: f.time, gap: f.gap, jump: f.jump, truth: f.truth };
        slot.egoIn = null;
        slot.view = views[pushed++ % views.length];
        grab(slot, f);
        count = Math.min(count + 1, slots.length);
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
        let detect;
        if (count < 2 * s + 1) {
            detect = { ok: false, reason: (count === s + 1 ? 'no previous frame' : `waiting for ${s} frames before`) + restarted(), candidates: [] };
        } else {
            const back = chain(s, s);         // t−s → t
            const fwd = chain(0, s);          // t → t+s
            if (!back.H) detect = { ok: false, reason: back.reason, candidates: [] };
            else if (!fwd.H && p.detectMode !== 'basic') detect = { ok: false, reason: fwd.reason, candidates: [] };
            else {
                const prev = at(2 * s), next = slot;
                detect = detector.detect({ prev: prev.grey, cur: cur.grey, next: next.grey, Hprev: back.H, Hnext: fwd.H || null,
                    small: { prev: prev.small, cur: cur.small, next: next.small, Hprev: back.Hs, Hnext: fwd.Hs || null } });
            }
        }
        // tracks: a step per frame with detections; without camera motion they coast
        const egoPrev = count >= s + 2 ? cur.egoIn : null;
        let tracks = null;
        if (detect.ok) tracks = tracker.step(detect.candidates, egoPrev && egoPrev.ok ? egoPrev.Hfull : null, (cur.meta.gap || 0) + 1);
        else if (count >= 2 * s + 1) tracks = tracker.step([], null, (cur.meta.gap || 0) + 1);
        const t3 = performance.now();

        const result = {
            ...cur.meta,
            width: geom.w, height: geom.h, scale: geom.scale, stride: s,
            small: { w: geom.sw, h: geom.sh, kx: geom.kx, ky: geom.ky },
            egoPrev,                                          // t−1 → t
            egoNext: at(s - 1).egoIn,                         // t → t+1
            detect,
            candidates: detect.candidates,
            tracks: tracks || [],
            confirmed: tracks ? tracks.filter(t => t.state === 'confirmed' && t.matched) : [],
            held: tracks ? tracks.filter(t => t.state === 'held') : [],     // stopped or lost, kept for a while
            timings: { grab: t1 - t0, ego: t2 - t1, detect: t3 - t2, total: t3 - t0 },
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
        setParams(next) {
            const cause = String(next.procWidth) !== String(p.procWidth) ? 'processing width changed'
                : next.estWidth !== p.estWidth ? 'estimation width changed' : null;
            p = { ...p, ...next };
            ego.setParams(egoParams(p));
            detector.setParams(detectParams(p));
            tracker.setParams(trackParams(p));
            if (cause && geom) setup(geom.srcW, geom.srcH, cause);
        },
        reset(cause = 'reset') { resetCause = cause; count = 0; ego.reset(); tracker.reset(); },
        dispose() {
            freeAll();
            for (const m of Object.values(scratch)) m.delete();
            ego.dispose();
            detector.dispose();
        },
    };
}
