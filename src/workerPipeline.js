// The Workers engine: the same job and interface as pipeline.js, with the heavy parts in Web
// Workers (procWorker.js), so detection runs on several cores and the page stays responsive.
//
//   main thread   grabs each frame (colour for display, grey + small grey, as pipeline.js), keeps
//                 the frame history, chains the camera-motion fits, runs the tracker
//   1 worker      camera motion between consecutive small frames (in order)
//   n workers     detection, each on a part of the frame: a strip of whole noise-tile rows with a
//                 tile row of context either side (detect.js stripsOf), or, with inclusion zones,
//                 some of the zones; candidates are merged
// Results match pipeline.js (a strip's noise tiles are the full frame's; scores agree to ~1e-4).
//
// push(f) returns a Promise; the frame is grabbed at once (f.image may change after the call)
// and frames are processed in order, in two overlapping stages (stageA / stageB): while frame n
// is detected, frame n+1 is taken in and its camera motion fitted. `accepting` says when the
// next frame may be pushed. Debug views: Stabilised on the main thread; Raw diff / Mask: while
// one is shown, the workers send their parts with each frame.
// The slow lane (slowLane.js) runs as in pipeline.js: its plan, tracker and display on the main
// thread, its detection as the same `detect` message to the workers (lane: 'slow'), sent along
// with the fast lane's.

import { createTracker } from './tracker.js';
import { stripsOf, DETECT_DEFAULTS } from './detect.js';
import { scaleH, mul, normalize, composeNewestFirst } from './homography.js';
import { mulberry32 } from './synth.js';
import { stackCrop, CROP } from './crops.js';
import { makeCanvas, egoParams, detectParams, trackParams, fitOf, fitErrOf, MAX_FPS, NEAR_MISSES, MAX_STRIDE,
    laneParams, prepareBlobs, joinLanes, slowSummary, nearList } from './pipeline.js';
import { createSlowLane, ringFrames, slowDetectParams } from './slowLane.js';
import { CV_URL } from './cvLoader.js';

// detection workers by default: one per core but one (measured on 4 cores at 1280×720: 2 → 84,
// 3 → 68, 4 → 82 ms per frame; the page and the camera-motion worker are mostly waiting)
export const autoWorkers = () => Math.max(1, Math.min(7, ((typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4) - 1));

function spawn(role, params) {
    const w = new Worker(new URL('./procWorker.js', import.meta.url), { type: 'module' });
    const waiting = new Map();          // key → resolve
    let readyResolve, readyReject;
    const ready = new Promise((res, rej) => { readyResolve = res; readyReject = rej; });
    let failed = null;
    w.onmessage = e => {
        const m = e.data;
        if (m.type === 'ready') readyResolve();
        else if (m.type === 'error') {
            const key = m.id !== undefined ? `d${m.id}` : m.seq !== undefined ? `e${m.seq}` : null;
            if (key && waiting.has(key)) { waiting.get(key).reject(new Error(m.message)); waiting.delete(key); } else { failed = m.message; readyReject(new Error(m.message)); }
        } else {
            const key = m.type === 'ego' ? `e${m.seq}` : `d${m.id}`;
            const p = waiting.get(key);
            if (p) { waiting.delete(key); p.resolve(m); }
        }
    };
    w.onerror = e => { failed = e.message || 'worker failed'; readyReject(new Error(failed)); for (const p of waiting.values()) p.reject(new Error(failed)); waiting.clear(); };
    w.postMessage({ type: 'init', role, cvUrl: new URL(`../${CV_URL}`, import.meta.url).href, params });
    return {
        ready,
        post: (msg, transfer) => w.postMessage(msg, transfer || []),
        ask(msg, key, transfer) {
            return new Promise((resolve, reject) => { waiting.set(key, { resolve, reject }); w.postMessage(msg, transfer || []); });
        },
        terminate() { try { w.postMessage({ type: 'dispose' }); } catch { /* gone */ } setTimeout(() => w.terminate(), 200); },
        get failed() { return failed; },
    };
}

export function createWorkerPipeline(cv, params) {
    let p = { ...params };
    const tracker = createTracker(trackParams(p));
    const lane = createSlowLane(laneParams(p));
    const nDet = Number(p.workers) > 0 ? Math.min(8, Math.round(Number(p.workers))) : autoWorkers();
    const egoW = spawn('ego', egoParams(p));
    const detW = Array.from({ length: nDet }, () => spawn('detect', detectParams(p)));
    const ready = Promise.all([egoW.ready, ...detW.map(w => w.ready)]);
    let readyState = 'starting';
    ready.then(() => { readyState = 'ready'; }, e => { readyState = `failed: ${e.message}`; });

    let geom = null, slots = [], views = [], rgba = null, head = -1, count = 0, pushed = 0, idx = -1;
    let tmpCanvas = null, grabCanvas = null;
    let resetCause = 'start';
    let stack = null;
    const scratch = {};
    let viewData = null;
    let chainA = Promise.resolve(), chainB = Promise.resolve();
    let lastB = Promise.resolve();       // stage B of the frame before the newest
    let detectId = 0;
    let disposed = false;

    const stride = () => Math.min(MAX_STRIDE, Math.max(1, Math.round(Number(p.stride) || 1)));
    const at = back => slots[(head - back + slots.length * 2) % slots.length];
    const toAll = msg => { egoW.post(msg); for (const w of detW) w.post(msg); };

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
        // one frame more than detection needs: the next frame comes in while this one is detected
        for (let i = 0; i < geom.ring + 1; i++) slots.push({ grey: new cv.Mat(h, w, cv.CV_8UC1), small: new cv.Mat(sh, sw, cv.CV_8UC1), meta: null, egoIn: null, view: null });
        for (let i = 0; i < s + 2; i++) {
            const canvas = makeCanvas(w, h);
            views.push({ canvas, ctx: canvas.getContext('2d', { willReadFrequently: true }) });
        }
        for (const m of Object.values(scratch)) m.delete();
        for (const k of Object.keys(scratch)) delete scratch[k];
        viewData = null;
        head = -1;
        count = 0;
        idx = -1;
        tracker.reset();
        lane.reset();
        toAll({ type: 'reset' });
    }

    // The frame's pixels at processing size, taken now (the caller's image may move on).
    function grabNow(f) {
        const pw = Number(p.procWidth) > 0 ? Math.min(f.width, Number(p.procWidth)) : f.width;
        const w = pw, h = Math.max(1, Math.round(f.height * pw / f.width));
        if (f.imageData && w === f.width) return new ImageData(new Uint8ClampedArray(f.imageData.data), w, h);
        if (!grabCanvas || grabCanvas.width !== w || grabCanvas.height !== h) grabCanvas = makeCanvas(w, h);
        const ctx = grabCanvas.getContext('2d', { willReadFrequently: true });
        if (f.imageData) {
            tmpCanvas ??= makeCanvas(f.width, f.height);
            if (tmpCanvas.width !== f.width || tmpCanvas.height !== f.height) { tmpCanvas.width = f.width; tmpCanvas.height = f.height; }
            tmpCanvas.getContext('2d').putImageData(f.imageData, 0, 0);
            ctx.drawImage(tmpCanvas, 0, 0, w, h);
        } else ctx.drawImage(f.image, 0, 0, w, h);
        return ctx.getImageData(0, 0, w, h);
    }

    function jitter(H, seq) {
        if (!(p.hJitter > 0)) return H;
        const r = mulberry32(seq * 2654435761);
        const dx = (r() * 2 - 1) * p.hJitter, dy = (r() * 2 - 1) * p.hJitter;
        return mul([1, 0, dx, 0, 1, dy, 0, 0, 1], H);
    }

    const restarted = () => (resetCause && resetCause !== 'start' ? ` (restarted: ${resetCause})` : '');

    // Raw diff / Mask: asked of the workers only while one of them is shown (renderView)
    let wantViews = false;
    let viewsOf = null;              // the result the assembled views belong to
    function assembleViews(list) {
        for (const k of ['vMask', 'vDiff']) {
            scratch[k] ??= new cv.Mat();
            scratch[k].create(geom.h, geom.w, cv.CV_8UC1);
            scratch[k].setTo(new cv.Scalar(0));
        }
        const M = scratch.vMask.data, D = scratch.vDiff.data;
        for (const v of list) {
            const o = v.y0 * v.w;
            for (let i = 0; i < v.mask.length; i++) {
                if (v.mask[i] > M[o + i]) M[o + i] = v.mask[i];
                if (v.diff[i] > D[o + i]) D[o + i] = v.diff[i];
            }
        }
        viewsOf = 'next';
    }

    // detection over the parts, merged
    // (lane 'slow': the slow lane's detector in each worker; no debug views)
    async function detectParts(args, lane = null) {
        const parts = stripsOf(geom.w, geom.h, detW.length, p.include);
        const id0 = detectId;
        detectId += parts.length;
        const views = lane ? false : wantViews;
        const outs = await Promise.all(parts.map((part, i) => detW[i].ask({ type: 'detect', id: id0 + i, ...args, part, views, lane }, `d${id0 + i}`)));
        const ds = outs.map(o => o.d);
        if (views && ds.every(d => d.ok && d.views)) assembleViews(ds.map(d => d.views));
        for (const d of ds) delete d.views;
        const bad = ds.find(d => !d.ok);
        if (bad) return bad;
        const sum = k => ds.reduce((a, d) => a + (d[k] || 0), 0);
        const out = { ok: true, reason: null, mode: ds[0].mode, candidates: ds.flatMap(d => d.candidates), weak: ds.flatMap(d => d.weak || []),
            rejected: ds.flatMap(d => d.rejected || []), components: sum('components'), noisy: ds.some(d => d.noisy), slivers: sum('slivers'),
            shiftRejected: sum('shiftRejected'), sizeRejected: sum('sizeRejected'), ...(ds[0].brightness ? { brightness: ds[0].brightness } : {}),
            ...(ds[0].tolerance !== undefined ? { tolerance: ds[0].tolerance } : {}),
            regions: parts.some(q => q.regions) ? parts.flatMap(q => q.regions || []) : null,
            processedArea: parts.some(q => q.regions) ? parts.flatMap(q => q.regions).reduce((a, r) => a + r.w * r.h, 0) / (geom.w * geom.h) : 1,
            timings: { diff: Math.max(...ds.map(d => (d.timings && d.timings.diff) || 0)) }, workers: parts.length };
        const cap = p.maxCandidates ?? DETECT_DEFAULTS.maxCandidates;
        if (Number.isFinite(cap) && out.candidates.length > cap) { out.candidates.length = cap; out.noisy = true; }
        return out;
    }

    // Stage A, in order: the frame into the history, sent to the workers, its camera motion.
    // Stage B, in order: detection and tracking of frame t = newest − s. B of one frame runs
    // while A of the next does (pipelined: the history keeps one frame more for that).
    async function stageA(f, image, prevB) {
        await ready;
        if (disposed) return null;
        const t0 = performance.now();
        const needs = !geom ? 'start' : geom.srcW !== f.width || geom.srcH !== f.height ? `video size changed to ${f.width}×${f.height}`
            : geom.stride !== stride() ? 'frame stride changed' : geom.ring !== ringFrames(stride(), p) ? 'slow lane changed' : null;
        if (needs) {
            await prevB;           // nothing may still be reading the history
            setup(f.width, f.height, needs);
        }
        const s = geom.stride;
        if (f.jump) {
            resetCause = f.jumpReason || (f.seq === 0 ? 'start' : 'seek');
            count = 0;
            idx = -1;
            egoW.post({ type: 'reset' });
        }
        head = (head + 1) % slots.length;
        const slot = slots[head];
        slot.meta = { seq: f.seq, frame: f.frame, time: f.time, gap: f.gap, jump: f.jump, truth: f.truth };
        slot.egoIn = null;
        slot.view = views[pushed++ % views.length];
        slot.view.ctx.putImageData(image, 0, 0);
        rgba.data.set(image.data);
        cv.cvtColor(rgba, slot.grey, cv.COLOR_RGBA2GRAY);
        cv.resize(slot.grey, slot.small, new cv.Size(geom.sw, geom.sh), 0, 0, cv.INTER_AREA);
        count = Math.min(count + 1, geom.ring);
        idx++;
        const ctx = { head, count, idx, s, slot, jump: f.jump, t0, grabMs: image.grabMs || 0 };
        const grey = slot.grey.data, small = slot.small.data;
        // copies handed over (transferred, not cloned again)
        for (const w of detW) {
            const g = grey.slice(), sm = small.slice();
            w.post({ type: 'frame', seq: f.seq, grey: g, small: sm, w: geom.w, h: geom.h, sw: geom.sw, sh: geom.sh }, [g.buffer, sm.buffer]);
        }
        const es = small.slice();
        const egoP = egoW.ask({ type: 'ego', seq: f.seq, small: es, w: geom.sw, h: geom.sh }, `e${f.seq}`, [es.buffer]);
        ctx.t1 = performance.now();
        const em = await egoP;
        if (ctx.count >= 2 && em.e) {
            const e = em.e;
            if (e.H) e.Hfull = jitter(scaleH(e.H, geom.kx, geom.ky), f.seq);
            slot.egoIn = e;
        }
        ctx.t2 = performance.now();
        return ctx;
    }

    async function stageB(ctx) {
        if (!ctx || disposed) return { slot: null, result: null };
        const { s } = ctx;
        const L = slots.length;
        const at = back => slots[(ctx.head - back + L * 2) % L];
        if (ctx.jump) { tracker.reset(); lane.reset(); }
        const tB = performance.now();
        if (ctx.count < s + 1) return { slot: at(ctx.count - 1), result: null };
        const cur = at(s);
        const egoPrev = ctx.count >= s + 2 ? cur.egoIn : null;
        let dt = (cur.meta.gap || 0) + 1;
        const prevT = ctx.count >= s + 2 ? at(s + 1).meta?.time : null;
        if (Number.isFinite(prevT) && Number.isFinite(cur.meta.time) && cur.meta.time > prevT) dt = Math.min(dt, Math.max(1, Math.round((cur.meta.time - prevT) * MAX_FPS)));
        const chainAt = (back, n) => {
            const fits = [];
            for (let i = back; i < back + n; i++) {
                const e = at(i).egoIn;
                if (!e || !e.ok) return { reason: e ? `camera motion: ${e.reason}` : `no previous frame${restarted()}` };
                fits.push(e);
            }
            const err = Math.max(...fits.map(e => fitErrOf(e, p) * geom.kx)) * Math.sqrt(n);
            return { H: normalize(composeNewestFirst(fits.map(e => e.Hfull))), Hs: normalize(composeNewestFirst(fits.map(e => e.H))), err };
        };
        // the slow lane's pass, when one is due: its detection is sent along with the fast lane's
        let slowPlan = null, slowP = null;
        if (p.slow) {
            slowPlan = lane.plan({ at, idx: ctx.idx, count: ctx.count, s, geom, wantTracked: true, nearMargin: p.nearMargin, nearOf: nearList });
            if (slowPlan.pass) {
                const P = slowPlan.pass;
                slowP = detectParts({ prev: at(2 * P.n).meta.seq, cur: at(P.n).meta.seq, next: ctx.slot.meta.seq, Hprev: P.Hprev, Hnext: P.Hnext,
                    Hs: P.Hs, fitErr: P.fitErr, tracked: P.tracked, near: P.near, params: slowDetectParams(detectParams(p), p) }, 'slow')
                    .catch(e => ({ ok: false, reason: `detection worker: ${e.message}`, candidates: [] }));
            }
        }
        let detect;
        let stk = { cur: cur.grey, prev: null, next: null, Hb: null, Hf: null };
        if (ctx.count < 2 * s + 1) {
            detect = { ok: false, reason: (ctx.count === s + 1 ? 'no previous frame' : `waiting for ${s} frames before`) + restarted(), candidates: [] };
        } else {
            const back = chainAt(s, s), fwd = chainAt(0, s);
            if (!back.H) detect = { ok: false, reason: back.reason, candidates: [] };
            else if (!fwd.H && p.detectMode !== 'basic') detect = { ok: false, reason: fwd.reason, candidates: [] };
            else {
                const prev = at(2 * s), next = ctx.slot;
                stk = { cur: cur.grey, prev: prev.grey, next: next.grey, Hb: back.H, Hf: fwd.H || null };
                const tracked = p.shiftCheck && egoPrev && egoPrev.ok
                    ? tracker.predict(egoPrev.Hfull, dt, { onlyPinned: true }).map(t => ({ x: t.x, y: t.y })) : [];
                const near = p.nearMargin > 0 && egoPrev && egoPrev.ok ? nearList(tracker.predict(egoPrev.Hfull, dt, { maxMisses: NEAR_MISSES })) : [];
                try {
                    detect = await detectParts({ prev: prev.meta.seq, cur: cur.meta.seq, next: next.meta.seq, Hprev: back.H, Hnext: fwd.H || null,
                        Hs: { Hprev: back.Hs, Hnext: fwd.Hs || null }, fitErr: Math.max(back.err, fwd.err || 0), tracked, near });
                } catch (e) {
                    detect = { ok: false, reason: `detection worker: ${e.message}`, candidates: [] };
                }
            }
        }
        let tracks = null;
        const meta = { time: cur.meta.time, frame: cur.meta.frame };
        if (detect.ok) {
            const blobs = prepareBlobs(detect, cur.grey, p);
            tracks = tracker.step(blobs, egoPrev && egoPrev.ok ? egoPrev.Hfull : null, dt, meta);
        } else if (ctx.count >= 2 * s + 1) tracks = tracker.step([], null, dt, meta);
        stack = stk;
        const t3 = performance.now();
        let slow = [], slowInfo = null;
        if (p.slow) {
            let d = null;
            if (slowP) {
                const P = slowPlan.pass, u = at(P.n);
                d = await slowP;
                lane.step(P, d, d.ok ? prepareBlobs(d, u.grey, p) : null, ctx.idx, { time: u.meta.time, frame: u.meta.frame });
            }
            slow = lane.shown({ at, idx: ctx.idx, count: ctx.count, s, geom, fast: tracks || [] });
            slowInfo = slowSummary(lane, d, performance.now() - t3);
        }
        const t4 = performance.now();
        const joined = joinLanes(tracks, slow);
        const hasViews = viewsOf === 'next';
        if (hasViews) viewsOf = null;
        const result = {
            ...cur.meta,
            width: geom.w, height: geom.h, scale: geom.scale, stride: s,
            small: { w: geom.sw, h: geom.sh, kx: geom.kx, ky: geom.ky },
            egoPrev,
            fit: fitOf(egoPrev, geom),
            egoNext: at(s - 1).egoIn,
            detect,
            candidates: detect.candidates,
            tracks: joined.tracks,
            confirmed: joined.confirmed,
            held: joined.held,
            ...(slowInfo ? { slow: slowInfo } : {}),
            // grab: taking the frame and sending it; ego: waiting for camera motion; detect:
            // detection and tracking; total: the frame's own work (with the stages overlapping,
            // frames are taken faster than this)
            timings: { grab: ctx.t1 - ctx.t0 + ctx.grabMs, ego: ctx.t2 - ctx.t1, detect: t3 - tB, ...(slowInfo ? { slow: t4 - t3 } : {}), total: ctx.t2 - ctx.t0 + ctx.grabMs + (t4 - tB) },
            engine: 'workers',
        };
        if (hasViews) viewsOf = result;
        return { slot: cur, result, prevSlot: at(s + 1) };
    }

    function greyToCanvas(mat, ctx) {
        if (!viewData || viewData.width !== mat.cols || viewData.height !== mat.rows) viewData = new ImageData(mat.cols, mat.rows);
        const src = mat.data, dst = viewData.data;
        for (let i = 0, j = 0; i < src.length; i++, j += 4) { dst[j] = dst[j + 1] = dst[j + 2] = src[i]; dst[j + 3] = 255; }
        ctx.putImageData(viewData, 0, 0);
    }

    return {
        // Resolves with { slot, result } of frame t; `accepting` resolves as soon as the next frame
        // can be pushed (this one's stage A and the previous one's stage B are done).
        push(f) {
            const t0 = performance.now();
            const image = grabNow(f);
            image.grabMs = performance.now() - t0;
            // stage A of this frame waits for stage B of the frame before last: the history holds
            // one frame more than a detection reads, so at most one frame may be ahead
            const bBeforeLast = lastB;
            const prevB = chainB;
            const a = Promise.all([chainA, bBeforeLast]).then(() => stageA(f, image, prevB));
            chainA = a.catch(() => null);
            lastB = prevB;
            const b = Promise.all([a, prevB]).then(([ctx]) => stageB(ctx));
            chainB = b.catch(() => null);
            this.accepting = Promise.all([chainA, prevB]);
            return b;
        },
        accepting: Promise.resolve(),
        renderView(view, out, ctx) {
            const slot = out.slot, r = out.result;
            if (!slot) return null;
            if (view === 'stabilised') {
                if (!r || !r.egoPrev || !r.egoPrev.ok) {
                    ctx.drawImage(slot.view.canvas, 0, 0);
                    return r && r.egoPrev ? `no camera motion for this frame: ${r.egoPrev.reason}` : `no previous frame${restarted()}`;
                }
                const prev = out.prevSlot || at(geom.stride + 1);
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
                wantViews = true;
                if (r && viewsOf === r && scratch.vMask) {
                    greyToCanvas(view === 'mask' ? scratch.vMask : scratch.vDiff, ctx);
                    return null;
                }
                ctx.drawImage(slot.view.canvas, 0, 0);
                return r && !r.detect.ok ? `no detection for this frame: ${r.detect.reason}` : 'shown from the next frame processed (Workers engine)';
            }
            wantViews = false;
            ctx.drawImage(slot.view.canvas, 0, 0);
            return null;
        },
        get geometry() { return geom; },
        get resetCause() { return resetCause; },
        get engine() { return 'workers'; },
        get workers() { return detW.length; },
        get state() { return readyState; },
        ready,
        setParams(next) {
            const cause = String(next.procWidth) !== String(p.procWidth) ? 'processing width changed'
                : next.estWidth !== p.estWidth ? 'estimation width changed' : null;
            p = { ...p, ...next };
            tracker.setParams(trackParams(p));
            lane.setParams(laneParams(p));
            egoW.post({ type: 'params', params: egoParams(p) });
            for (const w of detW) w.post({ type: 'params', params: detectParams(p) });
            if (cause && geom) { const g = geom; chainA = chainA.then(() => chainB).then(() => setup(g.srcW, g.srcH, cause)); }
        },
        crop(cx, cy, side = CROP) {
            if (!stack) return null;
            const g = m => (m ? { cols: m.cols, rows: m.rows, data: m.data } : null);
            return stackCrop({ cur: g(stack.cur), prev: g(stack.prev), next: g(stack.next), Hb: stack.Hb, Hf: stack.Hf }, cx, cy, side);
        },
        setPinned(ids) { tracker.setPinned(ids); lane.setPinned(ids); },
        reset(cause = 'reset') { resetCause = cause; count = 0; idx = -1; stack = null; tracker.reset(); lane.reset(); egoW.post({ type: 'reset' }); },
        dispose() {
            disposed = true;
            Promise.all([chainA, chainB]).then(() => {
                freeAll();
                for (const m of Object.values(scratch)) m.delete();
            });
            egoW.terminate();
            for (const w of detW) w.terminate();
        },
    };
}
