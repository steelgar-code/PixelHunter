// The long comparison: a third lane, over seconds instead of frames, on averaged frames, for
// objects slower than about 0.25 px a frame, for 1–2 px objects and low contrast, and for what
// video compression updates late (a slow small object is often left in place by the encoder and
// moved on in a jump some frames later). Pure: no DOM, no OpenCV; both engines run it the same way.
// The engines do the pixel work it asks for (blockStore in pipeline.js) and the detector call.
//
//   Block frames   a second history of blocks, each the average of B consecutive source frames,
//                  every frame warped once (with the per-frame fits) onto the block's FIRST frame
//                  (its anchor) and added to a running sum: one warp per frame, and no frame is
//                  interpolated twice. Where real time dropped frames a block covers the same time
//                  with fewer frames. A block is dropped (and the lane rests over it) when a fit
//                  inside it is missing or the picture moved more than the lane's budget within it.
//                  B = 4, or ⌈… ⌉ more when the length asked for is beyond 12 blocks of 4 (blockPlan).
//   Comparison     block u against u − m and u + m (the newest block), m ≤ 12 blocks, chosen as
//                  the slow lane chooses n (slowLane.js chooseN: the longest the camera's motion
//                  allows, never across a missing fit, u never back), a pass every
//                  max(2, ⌈m / 3⌉) blocks, the same detector call with the lane's detector settings.
//                  The ring holds 25 blocks (the engine's Mats; here only what is known of them).
//   H              between blocks: the product of the per-frame fits from one anchor to the next.
//   Tracking       a tracker of its own (ids from LONG_ID_BASE), stepped once per pass with dt in
//                  source frames, carried by the fits; up to LONG_TOP px a frame (faster objects
//                  are the slow lane's); the user's confirmation settings, hold time and "N within
//                  T s" scaled to passes. Its tracks are carried to the displayed frame with the
//                  fits and the velocity of the path through their recent sightings, and hidden
//                  where a confirmed fast or slow track follows the same object (fast before slow
//                  before long); lane: 'long'.
// A block's contents show an object where it was on average over the block's frames, in the
// anchor's coordinates; its time for the tracker is that mean (`offset` source frames after the
// anchor).

import { createTracker } from './tracker.js';
import { project, mul, inv, normalize, IDENTITY } from './homography.js';
import { chooseN, laneChain, cadenceOf, ragged, SLOW_SPARSE, SLOW_TOL_BASE, SLOW_SHIFT, carryTrack, sameObject, laneCrops, LANE_TRAIL } from './slowLane.js';

export const LONG_ID_BASE = 2000000;   // the lane's track ids start here
export const LONG_RING = 25;           // blocks kept (2 · LONG_MAX + 1)
export const LONG_MAX = 12;            // blocks: the longest comparison either side
export const LONG_BLOCK = 4;           // frames a block averages (at least)
export const LONG_MIN = 3;             // blocks: the shortest comparison (shorter ones are the slow lane's)
// px a frame: fastest track the lane starts and keeps (faster ones: the slow lane's). The brief's 0.5
// let it follow the 0.5 px-a-frame objects of far-0.5-crf23, which compression updates late: shown
// carried ~60 frames on, off the object, 6.8 false tracks a minute (Mid, two seeds); at 0.35 none, and
// every far scenario's numbers otherwise identical
export const LONG_TOP = 0.35;
// px: candidates of block u this close to a place where a confirmed fast or slow track (faster than the lane follows) had an actual
// sighting (not a coasted position) within the comparison's span before u until now are dropped before
// the lane's tracker: an object that stood still (g-stopgo: 2 s) is present in the blocks inside the stop
// and absent ±48 frames away, so the comparison saw it at the stop's place and the track stayed there
// after it left (Mid 3.3, Highest 4.2 false tracks a minute, six seeds; 0 with this)
export const LONG_GHOST = 6;
export const LONG_SECS = 2;            // default length either side, s
// the user's min travel × this (along the path fitted to the sightings): a 0.05 px-a-frame object
// needs 60 frames for 3 px. Measured, far-0.05, Mid, two seeds: 1 → median latency 167 frames
// (3 px contrast 20), 0.5 → 135; empty twins and recall once found unchanged
export const LONG_TRAVEL = 0.5;
// The detector's allowance for misalignment: the worst fit's misfit × LONG_ERR_K, whatever the time
// between the blocks. Measured (batch 3, chained fits against the synthetic truth, corners and
// centre, processing px, median / 90th percentile over 4, 12, 48, 96 frames): tripod 0.026 / 0.041,
// 0.056 / 0.083, 0.030 / 0.048, 0.048 / 0.068; hovering 0.06 / 0.10, 0.08 / 0.11, 0.10 / 0.15,
// 0.10 / 0.14. The error stops growing after a few frames (each frame's own registration error, not
// a random walk), while misfit × √48 (as the slow lane would grow it) gives 0.24–0.26 px: the
// allowance then swallowed a 3 px object that moved 2.4 px (raw 70 %, far-0.05). With K = 1.75 the
// allowance is about 0.22 px on these scenes (tolBase + 2 × misfit × kx × K), above the hovering
// camera's 90th percentile.
export const LONG_ERR_K = 1.75;
const FPS_FRAMES = 6;                  // frames looked at to know the source's frame rate
const DEFAULT_FPS = 25;                // when the frames carry no times

export const longSecsOf = p => Math.min(4, Math.max(0.5, Number(p.longSecs) || LONG_SECS));
// frames a block averages and the longest comparison in blocks for `secs` seconds either side at
// `fps`: 12 blocks of 4 frames up to 48 frames; beyond that the block grows, not the ring
export function blockPlan(secs, fps) {
    const total = secs * fps;
    const B = Math.max(LONG_BLOCK, Math.round(total / LONG_MAX));
    return { B, mMax: Math.max(LONG_MIN, Math.min(LONG_MAX, Math.round(total / B))) };
}
// the detector's settings in this lane: the slow lane's (slowDetectParams), tolBase / shift options to measure
export const longDetectParams = (dp, p = {}) => ({ ...dp, shiftCheck: p.longShiftCheck ?? true, tolBase: p.longTolBase ?? p.slowTolBase ?? SLOW_TOL_BASE,
    shiftMax: Math.max(dp.shiftMax ?? 2, p.longShift ?? p.slowShift ?? SLOW_SHIFT), edgeMargin: true,
    ...(p.longSigmas ? { sigmas: p.longSigmas } : {}), ...(p.longMinContrast ? { minContrast: p.longMinContrast } : {}) });

const PTS = w => h => [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1], [(w - 1) / 2, (h - 1) / 2]];
const movedBy = (M, pts) => Math.max(...pts.map(([x, y]) => { const [a, b] = project(M, x, y); return Math.hypot(a - x, b - y); }));

export function createLongLane(params = {}) {
    let p = { ...params };
    const tracker = createTracker({ firstId: LONG_ID_BASE });
    let fits;           // per pushed frame, oldest first: { egoIn (fit from the frame before), meta, frames (source frames since it) }
    let g;              // index of the newest pushed frame since the reset
    let fps, plan;      // the source's frame rate and { B, mMax }, once known
    let cur;            // the block being built: { anchor (g), meta, H, Hs (anchor → newest), n, src, offs, worst }
    let link;           // from the last kept block's anchor to the newest frame: { ok, H, Hs, misfit, nfits, frames }
    let blocks;         // kept blocks, oldest first: { seq, anchor, meta, offset, n, egoIn: link from the block before }
    let seq;            // blocks closed since the reset
    let lastU, lastPass, lastM, snap, fresh, stats, pending, crops;
    let seen, epoch, slowPasses, ghosts = 0;   // sightings of confirmed fast / slow tracks: { gi, ep, x, y } in the coordinates of the epoch's first frame

    function reset() {
        tracker.reset();
        fits = []; g = -1; fps = null; plan = null; cur = null; link = null; blocks = []; seq = 0;
        lastU = lastPass = lastM = null; snap = []; fresh = false; pending = null; crops = new Map();
        seen = []; epoch = 0; slowPasses = null; ghosts = 0;
        stats = { state: p.long ? 'waiting' : 'off', reason: 'waiting for frames' };
    }
    reset();

    function trackerParams(c) {
        const top = p.longTop ?? LONG_TOP;
        return { ...p.track, trail: LANE_TRAIL, maxSpeed: top, holdFrames: Math.max(1, Math.ceil((p.track.holdFrames ?? 50) / c)),
            confirmSecs: (p.track.confirmSecs ?? 0.2) * c, fixedMinMove: 3, travelFit: true, lineFit: true,
            maxTrackSpeed: top, keepMoving: true, speedPerSize: 0,
            minTravel: (p.track.minTravel ?? 3) * (p.longTravel ?? LONG_TRAVEL), pathTolerance: (p.track.pathTolerance ?? 1.5) * (p.longPath ?? 1) };
    }

    const keep = () => (LONG_RING + 2) * (plan ? plan.B : 20) + 40;
    // the fit history as `at(b)` (b frames before the newest), as the engines' frame history
    const fitAt = b => fits[fits.length - 1 - b];
    const blockAt = b => blocks[blocks.length - 1 - b];
    const framesBetween = (from, to) => { let d = 0; for (let b = from; b < to; b++) d += fitAt(b).frames; return d; };

    function knowFps() {
        if (fps !== null || fits.length < FPS_FRAMES) return fps !== null;
        const r = [];
        for (let i = 1; i < fits.length; i++) {
            const a = fits[i - 1].meta, b = fits[i].meta;
            if (a && b && Number.isFinite(a.time) && Number.isFinite(b.time) && b.time > a.time) r.push(fits[i].frames / (b.time - a.time));
        }
        r.sort((x, y) => x - y);
        fps = r.length ? r[r.length >> 1] : DEFAULT_FPS;
        plan = blockPlan(longSecsOf(p), fps);
        return true;
    }

    // a link to the newest frame: extended by its fit
    function extend(l, e, frames) {
        if (!l) return null;
        if (!e || !e.ok) return { ...l, ok: false, frames: l.frames + frames };
        return { ok: l.ok, H: mul(e.Hfull, l.H), Hs: mul(e.H, l.Hs), misfit: Math.max(l.misfit, e.misfit ?? e.err90 ?? 0.15), nfits: l.nfits + 1, frames: l.frames + frames };
    }
    const fresh0 = () => ({ ok: true, H: IDENTITY.slice(), Hs: IDENTITY.slice(), misfit: 0, nfits: 0, frames: 0 });

        // blobs of block u without those at a place a confirmed fast or slow track was seen in the span
    function ghostFree(pl, blobs) {
            const u = blocks.find(b => b.seq === pl.seqs.cur);
            const fu = u && fits[u.anchor - (g - fits.length + 1)];
            const Cinv = fu && inv(fu.C);
            if (!Cinv || !seen.length) return blobs;
            const t0 = u.anchor + Math.round(u.offset) - pl.m * plan.B;
            const near = [];
            for (const q of seen) if (q.ep === fu.ep && q.gi >= t0) near.push(project(Cinv, q.x, q.y));
            if (!near.length) return blobs;
            const R = p.longGhost ?? LONG_GHOST;
            const keep = blobs.filter(b => !near.some(([x, y]) => Math.hypot(b.cx - x, b.cy - y) <= R));
            ghosts = blobs.length - keep.length;
            return keep;
    }

    return {
        get tracker() { return tracker; },
        get stats() { return stats; },
        get plan() { return plan; },
        setParams(next) {
            const was = longSecsOf(p), wasOn = !!p.long;
            p = { ...p, ...next };
            // switched off and on again would continue the old history across the gap as if no frames were missing
            if ((plan && longSecsOf(p) !== was) || !!p.long !== wasOn) reset();
        },
        setPinned(ids) { tracker.setPinned(ids); },
        reset,
        // after step: crops of its tracks from the pass's blocks (slowLane.js laneCrops); crop(id)
        keepCrops(stack) { crops = laneCrops(snap, stack); },
        crop(id) { return crops.get(id) || null; },

        // The newest frame came in (its fit from the frame before: e; source frames since it:
        // frames; geom: { w, h, kx }). Returns what the engine does with its pixels, in order:
        // { op: 'start' } a new block from this frame · { op: 'add', H } this frame warped by
        // H⁻¹ (H: anchor → this frame, processing px) and added · { op: 'close', slot, n } the block
        // is the sum / n, kept in ring slot `slot` (its small copy made from it).
        addFrame({ e, meta, frames = 1, geom }) {
            if (!p.long) { stats = { state: 'off' }; return []; }
            g++;
            // C: this frame's coordinates → the epoch's first frame's (a missing fit starts a new epoch)
            const prevC = g === 0 ? null : fits[fits.length - 1].C;
            const okFit = g > 0 && e && e.ok && prevC && inv(e.Hfull);
            if (!okFit) epoch++;
            fits.push({ egoIn: g === 0 ? null : e, meta, frames: g === 0 ? 1 : frames, ep: epoch, C: okFit ? mul(prevC, inv(e.Hfull)) : IDENTITY.slice() });
            if (fits.length > keep()) { fits.shift(); while (seen.length && seen[0].gi < g - fits.length + 1) seen.shift(); }
            if (!knowFps()) return [];
            const ops = [];
            const pts = PTS(geom.w)(geom.h);
            if (cur) {
                const ok = e && e.ok;
                const H = ok ? mul(e.Hfull, cur.H) : null;
                if (!ok || movedBy(H, pts) > (Number(p.slowBudget) || 0)) {
                    // dropped: the lane rests over it (the next block's link from the last kept one is broken)
                    cur = null;
                    link = link ? { ...link, ok: false } : null;
                    pending = !ok ? 'no camera motion for some frames' : 'camera moving';
                } else {
                    cur.H = H; cur.Hs = mul(e.H, cur.Hs);
                    cur.src += frames;
                    cur.offs += cur.src - 1;
                    cur.n++;
                    ops.push({ op: 'add', H });
                }
            }
            link = extend(link, g === 0 ? null : e, frames);
            if (!cur && !ops.length) {
                // a new block from this frame
                cur = { anchor: g, meta, H: IDENTITY.slice(), Hs: IDENTITY.slice(), n: 1, src: 1, offs: 0, link };
                link = fresh0();
                ops.push({ op: 'start' });
            }
            if (cur && cur.src >= plan.B) {
                const egoIn = cur.link && cur.link.ok
                    ? { ok: true, Hfull: normalize(cur.link.H), H: normalize(cur.link.Hs), misfit: cur.link.misfit, nfits: cur.link.nfits }
                    : { ok: false, reason: cur.link ? 'a block was dropped' : 'first block' };
                const b = { seq, anchor: cur.anchor, meta: cur.meta, offset: cur.offs / cur.n, n: cur.n, egoIn, frames: cur.link ? cur.link.frames : 0 };
                blocks.push(b);
                if (blocks.length > LONG_RING) blocks.shift();
                ops.push({ op: 'close', slot: seq % LONG_RING, n: cur.n, seq });
                seq++;
                cur = null;
                pending = null;
            }
            return ops;
        },

        // The displayed frame's (s frames before the newest) confirmed tracks of the fast lane and the
        // slow lane: remember where they were actually seen (the fast lane's matched ones; the slow
        // lane's on the frame its pass is shown first, at their last sighting), for step's ghost filter.
        // slowPass: the slow lane's count of passes (changes when it has a new pass).
        observe({ s, fast = [], slow = [], slowPass = null }) {
            if (!p.long || g < s) return;
            const f = fits[fits.length - 1 - s];
            if (!f) return;
            const gi = g - s;
            const add = (x, y) => seen.push({ gi, ep: f.ep, ...(([a, b]) => ({ x: a, y: b }))(project(f.C, x, y)) });
            // only tracks faster than the lane follows: a slow object a slow track follows is the lane's to find
            // too (first try, any speed: far-0.2's 3 px contrast 12 object 70 → 53 % recall, once found 85 → 64)
            const top = p.longTop ?? LONG_TOP;
            const fastEnough = t => Math.hypot(t.vx, t.vy) > top;
            for (const t of fast) if (t.state === 'confirmed' && t.matched && fastEnough(t)) add(t.x, t.y);
            if (slowPass !== slowPasses) { slowPasses = slowPass; for (const t of slow) if (t.state === 'confirmed' && t.matched && fastEnough(t)) add(t.lastSeen[0], t.lastSeen[1]); }
        },

        // After addFrame: whether to make a pass now, and with what (as slowLane's plan, in blocks):
        // { pass: { m, slots: { prev, cur, next }, Hprev, Hnext, Hs, fitErr, H, dt, tracked, near, meta } } or { rest }.
        plan({ geom, wantTracked = false, nearMargin = 0, nearOf = null }) {
            if (!p.long) { stats = { state: 'off' }; return { rest: 'off' }; }
            if (!plan) { stats = { state: 'waiting', reason: 'waiting for frames' }; return { rest: 'waiting for frames' }; }
            const newest = seq - 1;
            const justClosed = blocks.length && blocks[blocks.length - 1].seq === newest && fits.length && pending === null && !cur;
            if (!justClosed) {
                if (pending) stats = { state: 'resting', reason: pending, B: plan.B };
                else if (stats.state === 'pass' || stats.state === 'between') stats = { ...stats, state: 'between' };
                else if (!lastPass) stats = { state: 'waiting', reason: 'waiting for blocks', B: plan.B };
                return { rest: 'building a block' };
            }
            if (lastPass !== null && newest - lastPass < cadenceOf(lastM)) { stats = { ...stats, state: 'between' }; return { rest: 'between passes' }; }
            let lastBack = lastU === null ? null : newest - lastU;
            if (lastBack !== null && lastBack > blocks.length - 1) { tracker.reset(); snap = []; lastU = lastPass = lastM = null; lastBack = null; }
            const ch = chooseN({ at: blockAt, count: blocks.length, s: LONG_MIN - 1, max: plan.mMax, budget: Number(p.slowBudget) || 0, w: geom.w, h: geom.h, lastBack });
            if (!ch.n) { stats = { state: 'resting', reason: ch.reason === 'waiting for frames' ? 'waiting for blocks' : ch.reason, B: plan.B }; return { rest: ch.reason }; }
            const m = ch.n;
            const back = laneChain(blockAt, m, m, geom.kx), fwd = laneChain(blockAt, 0, m, geom.kx);
            // the allowance (LONG_ERR_K): the worst fit's misfit × K
            let worst = 0;
            for (let b = 0; b < 2 * m; b++) worst = Math.max(worst, blockAt(b).egoIn.misfit ?? 0.15);
            const fitErr = worst * geom.kx * (p.longErrK ?? LONG_ERR_K);
            let H = null, dt = 1;
            if (lastBack !== null) {
                const c = laneChain(blockAt, m, lastBack - m, geom.kx);
                if (c.H) { H = c.H; dt = 0; for (let b = m; b < lastBack; b++) dt += blockAt(b).frames; } else { tracker.reset(); snap = []; }
            }
            if (!H) H = IDENTITY.slice();
            dt = Math.max(1, Math.round(dt));
            const tracked = wantTracked ? tracker.predict(H, dt, { onlyPinned: true }).map(t => ({ x: t.x, y: t.y })) : [];
            const near = nearMargin > 0 && nearOf ? nearOf(tracker.predict(H, dt, { maxMisses: 3 })) : [];
            const u = blockAt(m);
            const meta = { time: Number.isFinite(u.meta?.time) ? u.meta.time + u.offset / fps : u.meta?.time, frame: Number.isFinite(u.meta?.frame) ? u.meta.frame + Math.round(u.offset) : u.meta?.frame };
            return { pass: { m, slots: { prev: blockAt(2 * m).seq % LONG_RING, cur: u.seq % LONG_RING, next: blockAt(0).seq % LONG_RING },
                seqs: { prev: blockAt(2 * m).seq, cur: u.seq, next: blockAt(0).seq },
                Hprev: back.H, Hnext: fwd.H, Hs: { Hprev: back.Hs, Hnext: fwd.Hs }, fitErr, H, dt, tracked, near, meta } };
        },

        // After the pass's detection: one tracker step on block u.
        step(pl, detect, blobs) {
            const cb = cadenceOf(pl.m);
            tracker.setParams(trackerParams(cb * plan.B));
            const sparse = p.slowSparse ?? SLOW_SPARSE;
            if (blobs && sparse > 0) blobs = blobs.filter(b => !ragged(b, sparse));
            ghosts = 0;
            if (blobs && blobs.length) blobs = ghostFree(pl, blobs);
            snap = detect.ok ? tracker.step(blobs, pl.H, pl.dt, pl.meta) : tracker.step([], null, pl.dt, pl.meta);
            fresh = true;
            lastU = pl.seqs.cur;
            lastPass = pl.seqs.next;
            lastM = pl.m;
            stats = { state: 'pass', m: pl.m, B: plan.B, frames: pl.m * plan.B, secs: pl.m * plan.B / fps, cadence: cb, cadenceFrames: cb * plan.B,
                frame: pl.meta.frame, tolerance: detect.tolerance ?? null, candidates: detect.ok ? detect.candidates.length : null, ghosts, reason: detect.ok ? null : detect.reason };
        },

        // The lane's tracks on the displayed frame (s frames before the newest), carried there, without
        // those a confirmed fast or slow track already follows (others: the tracks shown already).
        shown({ s, others }) {
            if (!p.long || lastU === null || !snap.length) return [];
            const u = blocks.find(b => b.seq === lastU);
            if (!u) return [];
            const back = g - u.anchor;                 // frames from the anchor of u to the newest
            if (back > fits.length - 1 || back < s) return [];
            const k = back - s;
            // H(anchor u → displayed frame): the fits of the frames after the anchor up to it
            const c = k > 0 ? laneChain(fitAt, s, k, 1) : { H: IDENTITY.slice() };
            if (!c.H) return [];
            const kf = (k > 0 ? framesBetween(s, back) : 0) - u.offset;
            const conf = others.filter(f => f.state === 'confirmed');
            const out = [];
            for (const t of snap) {
                const q = carryTrack(t, c.H, kf, 2, 'long');
                if (conf.some(f => sameObject(f, q))) continue;
                if (!fresh) delete q.early;
                out.push(q);
            }
            fresh = false;
            if (stats.state !== 'off') stats = { ...stats, shown: out.length };
            return out;
        },
    };
}
