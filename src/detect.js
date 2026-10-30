// Independently moving pixels, in frame t's coordinates, once camera motion is cancelled.
// No DOM; `cv` is passed in.
//
// Basic mode (two frames, M2): warp t−1 onto t with H(t−1→t), absolute difference, threshold,
// AND with the border mask (where the warped frame has data, shrunk by a margin), then
// connected components with an area filter.
//
// Robust mode (three frames, M3), built so objects a few pixels across survive:
//   - t−1 and t+1 are both warped onto t; each difference is thresholded and the two masks are
//     ANDed, which removes the ghost at the object's old (or next) position and halves noise;
//   - each warped neighbour's mean brightness is matched to frame t first (offset measured on
//     the small frames, inside their overlap), absorbing auto-exposure changes;
//   - each pixel is compared with the 3×3 min and max of the warped neighbour:
//     d = max(0, cur − dilate(w)) + max(0, erode(w) − cur), so 1–2 px misregistration along
//     edges doesn't show up as motion;
//   - no smoothing by default (3×3 blur and a 3×3 opening are options).
//
// Exclusion zones (zones.js) are cleared from the valid region in frame t and also where each
// compared frame's zones land once warped onto t: an overlay fixed on screen sits somewhere
// else in the stabilised neighbours, and would show up there as a difference too.
//
// Inclusion zones crop detection: only the box around each zone (plus REGION_PAD, overlapping
// boxes merged) is processed, so the cost falls with the area watched. Neighbours are warped
// straight into the box (H composed with a translation), and only pixels inside an inclusion
// zone can become candidates. Coordinates in results are always full-frame.

import { project, inv, mul } from './homography.js';
import { zoneRect, regionRects } from './zones.js';

const SHIFT = 4;               // fillConvexPoly fractional bits: vertices to 1/16 px
const ZONE_PAD = 2;            // px around a zone: interpolation and the 3×3 min / max reach
const REGION_PAD = 4;          // px of context around an inclusion zone (3×3 blur, min / max)

export const DETECT_DEFAULTS = {
    detectMode: 'robust',  // 'robust' (three frames, M3) or 'basic' (two frames, M2)
    threshold: 20,         // grey levels
    minArea: 1,            // px (processing resolution)
    maxArea: 400,
    borderMargin: 3,       // px kept clear inside the warped frame's outline
    mergeDist: 2,          // blobs whose boxes are this close (px) become one candidate
    maxCandidates: 1000,   // more than this: keep the first ones, flag the frame as noisy
    brightness: true,      // match the neighbours' mean brightness to frame t (robust mode)
    blur: false,           // 3×3 Gaussian blur before differencing (robust mode)
    open: false,           // 3×3 opening of the final mask (removes 1–2 px blobs!)
    zones: [],             // exclusion zones, { x, y, w, h } fractions of the frame
    include: [],           // inclusion zones: when set, only these areas are processed
};

// Union of boxes closer than `d` px (gap between them), area-weighted centroids.
export function mergeClose(boxes, d) {
    const parent = boxes.map((_, i) => i);
    const find = i => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    const order = boxes.map((b, i) => i).sort((a, b) => boxes[a].x - boxes[b].x);
    for (let a = 0; a < order.length; a++) {
        const A = boxes[order[a]];
        for (let b = a + 1; b < order.length; b++) {
            const B = boxes[order[b]];
            if (B.x > A.x + A.w + d) break;           // sorted by x: nothing further can be close
            const gy = Math.max(A.y, B.y) - Math.min(A.y + A.h, B.y + B.h);
            if (gy <= d) parent[find(order[a])] = find(order[b]);
        }
    }
    const groups = new Map();
    boxes.forEach((b, i) => {
        const r = find(i);
        const g = groups.get(r);
        if (!g) { groups.set(r, { ...b, sx: b.cx * b.area, sy: b.cy * b.area }); return; }
        const x0 = Math.min(g.x, b.x), y0 = Math.min(g.y, b.y);
        g.w = Math.max(g.x + g.w, b.x + b.w) - x0;
        g.h = Math.max(g.y + g.h, b.y + b.h) - y0;
        g.x = x0; g.y = y0;
        g.area += b.area;
        g.sx += b.cx * b.area;
        g.sy += b.cy * b.area;
    });
    return [...groups.values()].map(({ sx, sy, ...g }) => ({ ...g, cx: sx / g.area, cy: sy / g.area }));
}

export function createDetector(cv, options = {}) {
    let p = { ...DETECT_DEFAULTS, ...options };
    let size = null;
    const m = {};              // preallocated Mats, (re)made in setup()
    let marginKernel = null;
    let marginKernelSize = -1;

    let k3 = null;
    let lastMode = null;       // mode of the last detection, for the debug views
    let lastCropped = false;   // last detection ran on inclusion regions (views in m.vMask / m.vDiff)

    function setup(w, h) {
        for (const k of Object.keys(m)) { m[k].delete(); delete m[k]; }
        size = { w, h };
        for (const k of ['warped', 'diff', 'mask', 'valid', 'labels', 'stats', 'centroids',
            'ero', 'dil', 'tmp', 'dNext', 'mPrev', 'valid2', 'curBlur', 'sWarp', 'sValid', 'inc']) m[k] = new cv.Mat();
        m.poly = new cv.Mat(4, 1, cv.CV_32SC2);
        if (!k3) k3 = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
    }

    function kernelFor(margin) {
        const k = 2 * margin + 1;
        if (k !== marginKernelSize) {
            if (marginKernel) marginKernel.delete();
            marginKernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(k, k));
            marginKernelSize = k;
        }
        return marginKernel;
    }

    // Where a sw×sh frame warped by H has full interpolation support (its outermost pixel
    // centres mapped by H, filled to 1/16 px), shrunk by `margin` (into `out`, w×h).
    function validRegion(H, out, w = size.w, h = size.h, margin = p.borderMargin, sw = w, sh = h) {
        out.create(h, w, cv.CV_8UC1);
        out.setTo(new cv.Scalar(0));
        const d = m.poly.data32S;
        [[0, 0], [sw - 1, 0], [sw - 1, sh - 1], [0, sh - 1]].forEach(([x, y], i) => {
            const [u, v] = project(H, x, y);
            d[2 * i] = Math.round(u * (1 << SHIFT));
            d[2 * i + 1] = Math.round(v * (1 << SHIFT));
        });
        cv.fillConvexPoly(out, m.poly, new cv.Scalar(255), cv.LINE_8, SHIFT);
        if (margin > 0) cv.erode(out, out, kernelFor(margin));
    }

    // Clears every exclusion zone from `out`, once per H (each a frame's own coordinates →
    // `out`'s: frame t, or a region of it).
    function clearZones(out, Hs) {
        const d = m.poly.data32S;
        for (const z of p.zones || []) {
            const r = zoneRect(z, size.w, size.h);
            if (r.x1 <= r.x0 || r.y1 <= r.y0) continue;
            const a = r.x0 - 0.5 - ZONE_PAD, b = r.y0 - 0.5 - ZONE_PAD, c = r.x1 - 0.5 + ZONE_PAD, e = r.y1 - 0.5 + ZONE_PAD;
            for (const H of Hs) {
                [[a, b], [c, b], [c, e], [a, e]].forEach(([x, y], i) => {
                    const [u, v] = project(H, x, y);
                    d[2 * i] = Math.round(u * (1 << SHIFT));
                    d[2 * i + 1] = Math.round(v * (1 << SHIFT));
                });
                cv.fillConvexPoly(out, m.poly, new cv.Scalar(0), cv.LINE_8, SHIFT);
            }
        }
    }

    function warp(src, H, dst, w = size.w, h = size.h) {
        const M = cv.matFromArray(3, 3, cv.CV_64F, H);
        try {
            cv.warpPerspective(src, dst, M, new cv.Size(w, h), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(0));
        } finally {
            M.delete();
        }
    }

    // Mean brightness of `cur` minus that of `ref` warped onto it by H, inside their overlap
    // (small frames: cheap).
    function brightnessOffset(ref, cur, H) {
        warp(ref, H, m.sWarp, cur.cols, cur.rows);
        validRegion(H, m.sValid, cur.cols, cur.rows, 1);
        return cv.mean(cur, m.sValid)[0] - cv.mean(m.sWarp, m.sValid)[0];
    }

    // d = max(0, cur − dilate(w)) + max(0, erode(w) − cur), w = ref warped onto t by H.
    function minMaxDiff(ref, H, offset, cur, out) {
        warp(ref, H, m.warped, cur.cols, cur.rows);
        if (offset) m.warped.convertTo(m.warped, -1, 1, offset);
        if (p.blur) cv.GaussianBlur(m.warped, m.warped, new cv.Size(3, 3), 0);
        cv.erode(m.warped, m.ero, k3);
        cv.dilate(m.warped, m.dil, k3);
        cv.subtract(cur, m.dil, out);
        cv.subtract(m.ero, cur, m.tmp);
        cv.add(out, m.tmp, out);
    }

    // Connected components, merged when their boxes are within mergeDist px of each other (a
    // faint object often breaks into pieces), then filtered by area.
    function blobs(mask, ox = 0, oy = 0) {
        const n = cv.connectedComponentsWithStats(mask, m.labels, m.stats, m.centroids, 8, cv.CV_32S);
        const st = m.stats.data32S, ce = m.centroids.data64F;
        let noisy = n - 1 > p.maxCandidates * 4;
        let parts = [];
        for (let i = 1; i < n && parts.length < p.maxCandidates * 4; i++) {
            const area = st[i * 5 + 4];
            if (area > p.maxArea) continue;
            parts.push({ x: st[i * 5] + ox, y: st[i * 5 + 1] + oy, w: st[i * 5 + 2], h: st[i * 5 + 3], area, cx: ce[i * 2] + ox, cy: ce[i * 2 + 1] + oy });
        }
        if (p.mergeDist > 0 && parts.length > 1) parts = mergeClose(parts, p.mergeDist);
        const out = [];
        for (const b of parts) {
            if (b.area < p.minArea || b.area > p.maxArea) continue;
            if (out.length >= p.maxCandidates) { noisy = true; break; }
            out.push(b);
        }
        return { candidates: out, components: n - 1, noisy };
    }

    // Frame t inside region r ({ x, y, w, h }, processing px): a view of `cur` and the
    // translation from full-frame to region coordinates.
    function regionOf(cur, r) {
        const full = r.x === 0 && r.y === 0 && r.w === size.w && r.h === size.h;
        return { view: full ? cur : cur.roi(new cv.Rect(r.x, r.y, r.w, r.h)), full, T: [1, 0, -r.x, 0, 1, -r.y, 0, 0, 1] };
    }

    // Valid pixels of region r: inside every compared frame's warped outline (Hs: those frames
    // → region), outside the exclusion zones, and inside an inclusion zone when there are any.
    function regionValid(r, T, Hs) {
        validRegion(Hs[0], m.valid, r.w, r.h, p.borderMargin, size.w, size.h);
        for (let i = 1; i < Hs.length; i++) {
            validRegion(Hs[i], m.valid2, r.w, r.h, p.borderMargin, size.w, size.h);
            cv.bitwise_and(m.valid, m.valid2, m.valid);
        }
        clearZones(m.valid, [T, ...Hs]);
        if (!p.include || !p.include.length) return;
        m.inc.create(r.h, r.w, cv.CV_8UC1);
        m.inc.setTo(new cv.Scalar(0));
        for (const z of p.include) {
            const q = zoneRect(z, size.w, size.h);
            const x0 = Math.max(q.x0, r.x), y0 = Math.max(q.y0, r.y), x1 = Math.min(q.x1, r.x + r.w), y1 = Math.min(q.y1, r.y + r.h);
            if (x1 <= x0 || y1 <= y0) continue;
            const v = m.inc.roi(new cv.Rect(x0 - r.x, y0 - r.y, x1 - x0, y1 - y0));
            v.setTo(new cv.Scalar(255));
            v.delete();
        }
        cv.bitwise_and(m.valid, m.inc, m.valid);
    }

    // Copies a region's mask and difference into the full-frame debug views.
    function keepViews(r, diffView) {
        const rect = new cv.Rect(r.x, r.y, r.w, r.h);
        for (const [dst, src] of [[m.vMask, m.mask], [m.vDiff, diffView]]) {
            const v = dst.roi(rect);
            src.copyTo(v);
            v.delete();
        }
    }

    // prev, cur: CV_8UC1 Mats at processing resolution; Hprev: H(t−1→t), 9 numbers.
    function detectBasic(prev, cur, Hprev, r) {
        const { view, full, T } = regionOf(cur, r);
        try {
            const Hp = mul(T, Hprev);
            warp(prev, Hp, m.warped, r.w, r.h);
            cv.absdiff(view, m.warped, m.diff);
            cv.threshold(m.diff, m.mask, p.threshold, 255, cv.THRESH_BINARY);
            regionValid(r, T, [Hp]);
            cv.bitwise_and(m.mask, m.valid, m.mask);
            if (!full) keepViews(r, m.diff);
            return blobs(m.mask, r.x, r.y);
        } finally {
            if (!full) view.delete();
        }
    }

    // Hprev: t−1 → t; Hnext: t → t+1 (inverted here); off: brightness offsets of t−1 and t+1.
    function detectRobust(prev, cur, next, Hprev, Hnext, off, r) {
        const { view, full, T } = regionOf(cur, r);
        try {
            const Hp = mul(T, Hprev), Hn = mul(T, inv(Hnext));
            let src = view;
            if (p.blur) {
                cv.GaussianBlur(view, m.curBlur, new cv.Size(3, 3), 0);
                src = m.curBlur;
            }
            minMaxDiff(prev, Hp, off[0], src, m.diff);
            minMaxDiff(next, Hn, off[1], src, m.dNext);
            cv.threshold(m.diff, m.mPrev, p.threshold, 255, cv.THRESH_BINARY);
            cv.threshold(m.dNext, m.mask, p.threshold, 255, cv.THRESH_BINARY);
            cv.bitwise_and(m.mask, m.mPrev, m.mask);
            regionValid(r, T, [Hp, Hn]);
            cv.bitwise_and(m.mask, m.valid, m.mask);
            if (p.open) cv.morphologyEx(m.mask, m.mask, cv.MORPH_OPEN, k3);
            if (!full) {
                cv.min(m.diff, m.dNext, m.tmp);
                keepViews(r, m.tmp);
            }
            return blobs(m.mask, r.x, r.y);
        } finally {
            if (!full) view.delete();
        }
    }

    // Runs one detection over the full frame, or over each inclusion region.
    function run(mode, args) {
        const t0 = performance.now();
        const regions = regionRects(p.include || [], size.w, size.h, REGION_PAD);
        lastCropped = regions !== null;
        let brightness;
        if (mode === 'robust') {
            const { small, Hnext } = args;
            let offPrev = 0, offNext = 0;
            if (p.brightness && small) {
                offPrev = brightnessOffset(small.prev, small.cur, small.Hprev);
                offNext = brightnessOffset(small.next, small.cur, inv(small.Hnext));
            }
            brightness = [offPrev, offNext];
            if (!Hnext) throw new Error('robust detection needs Hnext');
        }
        if (lastCropped) {
            for (const k of ['vMask', 'vDiff']) {
                m[k] ??= new cv.Mat();
                m[k].create(size.h, size.w, cv.CV_8UC1);
                m[k].setTo(new cv.Scalar(0));
            }
        }
        const out = { candidates: [], components: 0, noisy: false };
        for (const r of regions || [{ x: 0, y: 0, w: size.w, h: size.h }]) {
            const b = mode === 'robust'
                ? detectRobust(args.prev, args.cur, args.next, args.Hprev, args.Hnext, brightness, r)
                : detectBasic(args.prev, args.cur, args.Hprev, r);
            out.candidates.push(...b.candidates);
            out.components += b.components;
            out.noisy ||= b.noisy;
        }
        if (out.candidates.length > p.maxCandidates) { out.candidates.length = p.maxCandidates; out.noisy = true; }
        const t1 = performance.now();
        return { ...out, ...(brightness ? { brightness } : {}), regions: regions || null,
            processedArea: regions ? regions.reduce((a, r) => a + r.w * r.h, 0) / (size.w * size.h) : 1,
            timings: { diff: t1 - t0 } };
    }

    return {
        // { prev, cur, next } grey Mats, { Hprev, Hnext } (t−1→t, t→t+1), and `small`: the same
        // frames and H at estimation size (for brightness matching). Returns
        // { ok, reason, mode, candidates, components, noisy, brightness?, timings }.
        detect({ prev, cur, next, Hprev, Hnext, small }) {
            if (!size || size.w !== cur.cols || size.h !== cur.rows) setup(cur.cols, cur.rows);
            if (!prev || !Hprev) return { ok: false, reason: 'no camera motion for t−1 → t', candidates: [] };
            lastMode = p.detectMode;
            if (p.detectMode === 'basic') return { ok: true, reason: null, mode: 'basic', ...run('basic', { prev, cur, Hprev }) };
            if (!next || !Hnext) return { ok: false, reason: 'no camera motion for t → t+1', candidates: [] };
            return { ok: true, reason: null, mode: 'robust', ...run('robust', { prev, cur, next, Hprev, Hnext, small }) };
        },
        // Debug views of the last detection: 'diff' (×4 so faint differences show; robust mode:
        // the smaller of the two differences, i.e. what survives the AND) or 'mask'.
        viewMat(view) {
            if (!size) return null;
            if (lastCropped) {
                if (view === 'mask') return m.vMask;
                if (view === 'diff') {
                    m.view ??= new cv.Mat();
                    m.vDiff.convertTo(m.view, -1, 4, 0);
                    return m.view;
                }
                return null;
            }
            if (view === 'mask') return m.mask;
            if (view === 'diff') {
                m.view ??= new cv.Mat();
                if (lastMode === 'robust') {
                    cv.min(m.diff, m.dNext, m.tmp);
                    m.tmp.convertTo(m.view, -1, 4, 0);
                } else {
                    m.diff.convertTo(m.view, -1, 4, 0);
                }
                return m.view;
            }
            return null;
        },
        setParams(next) { p = { ...p, ...next }; },
        get params() { return p; },
        dispose() {
            for (const k of Object.keys(m)) { m[k].delete(); delete m[k]; }
            if (marginKernel) marginKernel.delete();
            if (k3) k3.delete();
            marginKernel = null;
            k3 = null;
        },
    };
}
