// The long comparison's pixel work (pipeline.js and the block worker use it).
import { LONG_RING } from './longLane.js';

// The long comparison's pixels (longLane.js addFrame's ops): the running sum of the block being
// built (32-bit float) and a ring of LONG_RING finished blocks (grey + small copy). Its Mats are
// made on first use (only while the long comparison is on) and kept until the size changes.
export function createBlockStore(cv, { pixels = true } = {}) {
    let dims = null, acc = null, f32 = null, tmp = null, ring = [];
    function free() {
        for (const m of [acc, f32, tmp]) if (m) m.delete();
        for (const b of ring) { b.grey.delete(); b.small.delete(); }
        acc = f32 = tmp = null; ring = []; dims = null;
    }
    function ensure(geom) {
        const key = `${geom.w}x${geom.h}/${geom.sw}x${geom.sh}`;
        if (dims === key) return;
        free();
        dims = key;
        if (pixels) {
            acc = new cv.Mat(geom.h, geom.w, cv.CV_32F);
            f32 = new cv.Mat(geom.h, geom.w, cv.CV_32F);
            tmp = new cv.Mat(geom.h, geom.w, cv.CV_32F);
        }
        for (let i = 0; i < LONG_RING; i++) ring.push({ grey: new cv.Mat(geom.h, geom.w, cv.CV_8UC1), small: new cv.Mat(geom.sh, geom.sw, cv.CV_8UC1) });
    }
    // ops on the newest frame's grey Mat; returns the blocks closed: [{ seq, slot }]
    function apply(ops, grey, geom) {
        const closed = [];
        for (const o of ops) {
            if (o.op === 'start') grey.convertTo(acc, cv.CV_32F);
            else if (o.op === 'add') {
                grey.convertTo(f32, cv.CV_32F);
                const M = cv.matFromArray(3, 3, cv.CV_64F, o.H);
                // H: anchor → this frame; with WARP_INVERSE_MAP each anchor pixel takes this frame's at H(x)
                cv.warpPerspective(f32, tmp, M, new cv.Size(geom.w, geom.h), cv.INTER_LINEAR | cv.WARP_INVERSE_MAP, cv.BORDER_REPLICATE, new cv.Scalar(0));
                M.delete();
                cv.add(acc, tmp, acc);
            } else if (o.op === 'close') {
                const b = ring[o.slot];
                acc.convertTo(b.grey, cv.CV_8U, 1 / o.n);
                cv.resize(b.grey, b.small, new cv.Size(geom.sw, geom.sh), 0, 0, cv.INTER_AREA);
                closed.push({ seq: o.seq, slot: o.slot });
            }
        }
        return closed;
    }
    // a block built elsewhere (the block worker): its pixels into the slot
    function put(slot, grey, small) { ring[slot].grey.data.set(grey); ring[slot].small.data.set(small); }
    return { ensure, apply, put, at: slot => ring[slot], dispose: free };
}
