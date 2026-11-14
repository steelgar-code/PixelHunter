// A worker of the Workers engine (workerPipeline.js), with its own OpenCV.js: camera motion
// ('ego': the LK + RANSAC fit between consecutive small frames, in order) or detection of one
// part of the frame ('detect': a strip of rows, or some inclusion regions; detect.js).
// Messages in: init { role, cvUrl, params } · params { params } · reset · ego { seq, small, w, h }
// · frame { seq, grey, small, w, h, sw, sh } · detect { id, prev, cur, next (seqs), …, part }
// (lane: 'slow': the slow lane's detector, slowLane.js; lane: 'long' with blocks: the long
// comparison's, on its block frames) · block { id, grey, small, w, h, sw, sh } · dispose. Replies: ready · ego { seq, e } · detected { id, d } · error { message }.

import { createEgomotion } from './egomotion.js';
import { createDetector } from './detect.js';
import { createBlockStore } from './blockStore.js';

const KEEP = 2 * 12 + 3;         // frames kept for detection (2 × the largest stride, and some)
let cv = null, role = null, ego = null, det = null;
let detSlow = null;              // detect: the slow lane's detector, made when first asked (its settings come with each request)
let detLong = null;              // … and the long comparison's
const blocks = new Map();        // detect: the long comparison's block frames, id → { grey, small } Mats
const KEEP_BLOCKS = 26;
let store = null, bframe = null;  // blocks: the long comparison's pixel work (blockStore.js) and the frame it is given
let lastSmall = null;            // ego: the previous small frame
const ring = new Map();          // detect: seq → { grey, small } Mats

async function loadCv(url) {
    const code = await (await fetch(url)).text();
    (0, eval)(code);             // the build's UMD wrapper sets self.cv (its worker branch)
    let c = self.cv;
    if (typeof c.Mat !== 'function') {
        c = await new Promise(resolve => {
            const prev = c.onRuntimeInitialized;
            c.onRuntimeInitialized = () => { if (prev) prev(); const ready = self.cv; delete ready.then; resolve(ready); };
        });
    }
    if (typeof c.then === 'function') delete c.then;
    return c;
}

function clearRing() {
    for (const f of ring.values()) { f.grey.delete(); f.small.delete(); }
    ring.clear();
    for (const f of blocks.values()) { f.grey.delete(); f.small.delete(); }
    blocks.clear();
}

const mat = (rows, cols, data) => { const m = new cv.Mat(rows, cols, cv.CV_8UC1); m.data.set(data); return m; };

function handle(msg) {
    switch (msg.type) {
    case 'params':
        if (ego) ego.setParams(msg.params);
        if (det) det.setParams(msg.params);
        return null;
    case 'reset':
        if (ego) ego.reset();
        if (lastSmall) { lastSmall.delete(); lastSmall = null; }
        clearRing();
        return null;
    case 'ego': {
        const cur = mat(msg.h, msg.w, msg.small);
        let e = null;
        if (lastSmall && lastSmall.cols === cur.cols && lastSmall.rows === cur.rows) e = ego.update(lastSmall, cur);
        if (lastSmall) lastSmall.delete();
        lastSmall = cur;
        return { type: 'ego', seq: msg.seq, e };
    }
    case 'frame': {
        ring.set(msg.seq, { grey: mat(msg.h, msg.w, msg.grey), small: mat(msg.sh, msg.sw, msg.small) });
        for (const k of [...ring.keys()]) if (k <= msg.seq - KEEP) { const f = ring.get(k); f.grey.delete(); f.small.delete(); ring.delete(k); }
        return null;
    }
    case 'block': {
        const old = blocks.get(msg.id);
        if (old) { old.grey.delete(); old.small.delete(); }
        blocks.set(msg.id, { grey: mat(msg.h, msg.w, msg.grey), small: mat(msg.sh, msg.sw, msg.small) });
        for (const k of [...blocks.keys()]) if (k <= msg.id - KEEP_BLOCKS || k > msg.id) { const f = blocks.get(k); f.grey.delete(); f.small.delete(); blocks.delete(k); }
        return null;
    }
    case 'blockops': {
        store ??= createBlockStore(cv);
        const geom = { w: msg.w, h: msg.h, sw: msg.sw, sh: msg.sh };
        store.ensure(geom);
        if (!bframe || bframe.cols !== msg.w || bframe.rows !== msg.h) { if (bframe) bframe.delete(); bframe = new cv.Mat(msg.h, msg.w, cv.CV_8UC1); }
        bframe.data.set(msg.grey);
        const closed = store.apply(msg.ops, bframe, geom).map(c => {
            const b = store.at(c.slot);
            return { seq: c.seq, slot: c.slot, grey: b.grey.data.slice(), small: b.small.data.slice() };
        });
        return { type: 'blocks', id: msg.id, gen: msg.gen, closed };
    }
    case 'detect': {
        const src = msg.blocks ? blocks : ring;
        const P = src.get(msg.prev), C = src.get(msg.cur), N = msg.next !== null ? src.get(msg.next) : null;
        if (!P || !C) return { type: 'detected', id: msg.id, d: { ok: false, reason: 'frame missing in a worker', candidates: [] } };
        if (msg.lane === 'slow') { detSlow ??= createDetector(cv, msg.params); detSlow.setParams(msg.params); }
        if (msg.lane === 'long') { detLong ??= createDetector(cv, msg.params); detLong.setParams(msg.params); }
        const d = (msg.lane === 'slow' ? detSlow : msg.lane === 'long' ? detLong : det).detect({ prev: P.grey, cur: C.grey, next: N ? N.grey : null, Hprev: msg.Hprev, Hnext: msg.Hnext,
            small: { prev: P.small, cur: C.small, next: N ? N.small : null, Hprev: msg.Hs.Hprev, Hnext: msg.Hs.Hnext },
            fitErr: msg.fitErr, tracked: msg.tracked, near: msg.near, part: msg.part, views: !!msg.views });
        // the debug views of this part, when one is shown (Raw diff / Mask)
        if (msg.views && d.ok) d.views = det.partViews();
        return { type: 'detected', id: msg.id, d };
    }
    case 'dispose':
        clearRing();
        if (lastSmall) lastSmall.delete();
        if (ego) ego.dispose();
        if (det) det.dispose();
        if (store) store.dispose();
        if (bframe) bframe.delete();
        if (detSlow) detSlow.dispose();
        if (detLong) detLong.dispose();
        self.close();
        return null;
    default:
        return null;
    }
}

let queue = Promise.resolve();
self.onmessage = e => {
    const msg = e.data;
    queue = queue.then(async () => {
        try {
            if (msg.type === 'init') {
                cv = await loadCv(msg.cvUrl);
                role = msg.role;
                if (role === 'ego') ego = createEgomotion(cv, msg.params);
                else if (role === 'detect') det = createDetector(cv, msg.params);
                self.postMessage({ type: 'ready' });
                return;
            }
            const out = handle(msg);
            if (out) self.postMessage(out);
        } catch (err) {
            self.postMessage({ type: 'error', message: err && err.message ? err.message : String(err), id: msg.id, seq: msg.seq });
        }
    });
};
