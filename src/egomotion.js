// Camera motion between consecutive small grey frames: grid-seeded corners, Lucas-Kanade
// tracking with a forward-backward check, and a RANSAC homography. No DOM; `cv` is passed in.
//
// Points carry over from frame to frame (the inliers of the last fit), and cells of a grid
// that have run short are topped up, so features stay spread over the image and one region
// (or one large moving object) can't dominate the fit.
//
// Each fit also reports how good it is: the median and 90th-percentile distance between where
// the fit puts each inlier and where it was tracked to (small-frame px), and the share of grid
// cells with tracked points that also hold inliers (coverage). A fit can have plenty of inliers
// and still be off in part of the frame; these show it.
//
// Points that can't be followed precisely are left out (fbRel): on flat areas (sky, haze, water)
// the best "corners" of a grid cell are sensor noise or compression blocks, which Lucas-Kanade
// follows to within a pixel or so: close enough to pass a fixed forward-backward limit and the
// RANSAC threshold, and far too loose for a fit that should be good to a tenth of a pixel. With
// the sky filling half the frame they were a quarter of the inliers, at ~35 × the error of points
// on the ground, and the fit's error at the frame corners went from ~0.1 px to 1–3 px. The
// forward-backward error says how precisely each point was followed, so among the points that
// agree with the RANSAC fit (which motion is the background's is decided as before, by all of
// them) only those within fbRel × the error of the best quarter (FB_QUANTILE), at least fbFloor
// and at most fbMax, are used: the fit is made again from them, and they are the points carried
// to the next frame. A blurred or compressed frame, where every point is followed less precisely,
// raises its own limit. A point that is followed well but doesn't move with the background
// (parallax, lens bending) still counts: that is the fit's error, and the detector's allowance
// for misalignment follows it. A cell whose new points are all dropped is left alone for
// retryEmptyAfter frames, like a cell without corners.
//
// Points in a thin band (the ground under a wide sky, a horizon) fit a homography well where they
// are and leave it nearly free over the rest of the frame: with the ground in the bottom sixth,
// one frame in ten was 5–10 px off at the top. How well the points pin the fit down is worked out
// from their scatter about it (cornerSpread: the standard deviation of where the fit puts the
// frame's corners; the true error runs a few times higher and follows it). Above `loose`, the fit
// is a similarity instead (shift, turn, zoom: four numbers, which a band of points does pin
// down). That leaves out the change of perspective in a pan, which grows with the lens angle
// (2 px at the corners of 640 px for 60° across at 15°/s; under 0.1 px for 10°), steadily from
// frame to frame, where the free homography jumped.
//
// Points inside exclusion zones (zones.js) are neither seeded nor used: an overlay fixed on
// screen tracks as "no motion" and would pull the fit towards the identity. Zones are grown by
// half the LK window, since a point next to a zone's edge is tracked with the overlay in view.

import { implausible, normalize, mul } from './homography.js';
import { inZones } from './zones.js';

export const EGO_DEFAULTS = {
    features: 400,         // point budget, split over the grid
    gridCols: 8,
    gridRows: 6,
    minDistance: 5,        // px between corners (small frame)
    quality: 0.01,         // goodFeaturesToTrack quality level
    lkWin: 15,             // LK window, px (odd). Was 21: 15 fits as well or better on every test
                           // scene and takes half the time (the cost grows with the area)
    lkLevels: 3,           // pyramid levels above the base image
    lkIters: 30,           // LK iterations per level, at most
    lkEps: 0.01,           // … stopping when a point moves less than this (px)
    fbMax: 1,              // forward-backward round trip, px: never more than this
    fbRel: 8,              // … and at most this × the round trip of the frame's best quarter (0: off)
    fbFloor: 0.03,         // … but that limit is never below this, px (LK itself stops at lkEps)
    loose: 0.15,           // px (at a 320 px wide frame): when the points leave the fit's corners less
                           // certain than this, a simpler fit is used (shift, turn, zoom; 0: never)
    reseedBelow: 100,      // fewer tracked points than this: seed the whole grid again
    ransacPx: 2,           // RANSAC reprojection threshold, small-frame px
    minInliers: 30,
    minInlierRatio: 0.5,
    retryEmptyAfter: 10,   // frames before re-trying a cell where no corner was found
    zones: [],             // exclusion zones, { x, y, w, h } fractions of the frame
};

const MISFIT_MIN = 3;           // points a grid cell needs for its mean offset to count
const FB_QUANTILE = 0.25;       // the "best quarter" of the inliers, or the best minInliers when that is fewer

export function createEgomotion(cv, options = {}) {
    let p = { ...EGO_DEFAULTS, ...options };
    let pts = new Float32Array(0);     // tracked points in the latest frame, x0 y0 x1 y1 …
    let size = null;                   // { w, h } of the small frames
    let cellRetry = [];                // frame number before which an empty cell isn't re-seeded
    let frameNo = 0;
    let seeded = new Set();            // cells that got new points this frame

    const none = new cv.Mat();

    function cellOf(x, y) {
        const c = Math.min(p.gridCols - 1, Math.floor(x / size.w * p.gridCols));
        const r = Math.min(p.gridRows - 1, Math.floor(y / size.h * p.gridRows));
        return r * p.gridCols + c;
    }

    // Adds corners to cells with fewer than a third of their share (all cells when `all`).
    function seed(img, all) {
        seeded = new Set();
        const cells = p.gridCols * p.gridRows;
        const quota = Math.max(1, Math.round(p.features / cells));
        const count = new Array(cells).fill(0);
        if (!all) for (let i = 0; i < pts.length; i += 2) count[cellOf(pts[i], pts[i + 1])]++;
        const added = [];
        for (let r = 0; r < p.gridRows; r++) {
            for (let c = 0; c < p.gridCols; c++) {
                const cell = r * p.gridCols + c;
                if (count[cell] >= quota / 3) continue;
                if (!all && cellRetry[cell] > frameNo) continue;
                const x0 = Math.floor(c * size.w / p.gridCols), x1 = Math.floor((c + 1) * size.w / p.gridCols);
                const y0 = Math.floor(r * size.h / p.gridRows), y1 = Math.floor((r + 1) * size.h / p.gridRows);
                const roi = img.roi(new cv.Rect(x0, y0, x1 - x0, y1 - y0));
                const found = new cv.Mat();
                try {
                    cv.goodFeaturesToTrack(roi, found, quota - count[cell], p.quality, p.minDistance, none, 3, false, 0.04);
                    const d = found.data32F;
                    let n = 0;
                    for (let i = 0; i < found.rows; i++) {
                        const x = d[2 * i] + x0, y = d[2 * i + 1] + y0;
                        if (!all && tooClose(x, y)) continue;
                        if (excluded(x, y)) continue;
                        added.push(x, y);
                        n++;
                    }
                    cellRetry[cell] = n ? 0 : frameNo + p.retryEmptyAfter;
                    if (n) seeded.add(cell);
                } finally {
                    roi.delete();
                    found.delete();
                }
            }
        }
        const merged = new Float32Array((all ? 0 : pts.length) + added.length);
        if (!all) merged.set(pts);
        merged.set(added, all ? 0 : pts.length);
        pts = merged;
    }

    // { err50, err90 (small px), misfit, coverage } of a fit, from the inliers it is made of.
    // err50 / err90: how far the points lie from where the fit puts them: mostly how precisely
    // each was followed. misfit: how far the picture itself is from the fit, in places: the
    // points' offsets averaged per grid cell (what a point was followed by averages out over a
    // cell, what the fit gets wrong there does not: parallax, lens bending, rolling shutter), the
    // 90th percentile over cells.
    function fitQuality(H, src, dst, points, idx) {
        const errs = [];
        const tracked = new Set(), covered = new Set();
        const cells = new Map();           // cell → [Σdx, Σdy, n]
        for (let j = 0; j < idx.length; j++) {
            const cell = cellOf(src[2 * j], src[2 * j + 1]);
            tracked.add(cell);
            if (points[idx[j] * 5 + 4] !== 1) continue;
            covered.add(cell);
            const x = src[2 * j], y = src[2 * j + 1];
            const d = H[6] * x + H[7] * y + H[8];
            const dx = (H[0] * x + H[1] * y + H[2]) / d - dst[2 * j], dy = (H[3] * x + H[4] * y + H[5]) / d - dst[2 * j + 1];
            errs.push(Math.hypot(dx, dy));
            const c = cells.get(cell) || [0, 0, 0];
            c[0] += dx; c[1] += dy; c[2]++;
            cells.set(cell, c);
        }
        errs.sort((a, b) => a - b);
        const q = (list, f) => (list.length ? list[Math.min(list.length - 1, Math.floor(list.length * f))] : null);
        const means = [...cells.values()].filter(c => c[2] >= MISFIT_MIN).map(c => Math.hypot(c[0], c[1]) / c[2]).sort((a, b) => a - b);
        return { err50: q(errs, 0.5), err90: q(errs, 0.9), misfit: means.length >= 4 ? q(means, 0.9) : q(errs, 0.9),
            coverage: tracked.size ? covered.size / tracked.size : 0 };
    }

    const excluded = (x, y) => p.zones && p.zones.length > 0 && inZones(p.zones, x, y, size.w, size.h, Math.max(3, (p.lkWin - 1) / 2));

    function tooClose(x, y) {
        const d2 = p.minDistance * p.minDistance;
        for (let i = 0; i < pts.length; i += 2) {
            const dx = pts[i] - x, dy = pts[i + 1] - y;
            if (dx * dx + dy * dy < d2) return true;
        }
        return false;
    }

    // A homography through point pairs (x y … arrays): RANSAC with the inliers into `mask`, or
    // (method 0) least squares over all of them. 9 numbers, or null.
    function fit(src, dst, method, mask) {
        const sm = cv.matFromArray(src.length / 2, 1, cv.CV_32FC2, src);
        const dm = cv.matFromArray(dst.length / 2, 1, cv.CV_32FC2, dst);
        try {
            const Hm = mask ? cv.findHomography(sm, dm, method, p.ransacPx, mask) : cv.findHomography(sm, dm, method);
            try {
                return Hm.rows === 3 && Hm.cols === 3 ? normalize(Array.from(Hm.data64F)) : null;
            } finally {
                Hm.delete();
            }
        } finally {
            sm.delete();
            dm.delete();
        }
    }

    // How well the points pin a homography down over the whole frame: the standard deviation
    // (px) of where a least-squares fit through them puts the frame's corners, the worst of the
    // four, from the points' own scatter about H (first-order error propagation). Points in a
    // thin band (ground under a wide sky) fit well where they are and say little about the rest.
    function cornerSpread(H, src, dst) {
        const n = src.length / 2;
        if (n < 6) return Infinity;
        // frame centre at 0, half the width = 1: keeps the 8×8 system well scaled
        const cx = (size.w - 1) / 2, cy = (size.h - 1) / 2, k = size.w / 2;
        const Hn = normalize(mul(mul([1 / k, 0, -cx / k, 0, 1 / k, -cy / k, 0, 0, 1], H), [k, 0, cx, 0, k, cy, 0, 0, 1]));
        const N = new Float64Array(64), ju = new Float64Array(8), jv = new Float64Array(8);
        const jac = (x, y) => {
            const w = Hn[6] * x + Hn[7] * y + 1, u = (Hn[0] * x + Hn[1] * y + Hn[2]) / w, v = (Hn[3] * x + Hn[4] * y + Hn[5]) / w;
            ju[0] = x / w; ju[1] = y / w; ju[2] = 1 / w; ju[3] = ju[4] = ju[5] = 0; ju[6] = -u * x / w; ju[7] = -u * y / w;
            jv[0] = jv[1] = jv[2] = 0; jv[3] = x / w; jv[4] = y / w; jv[5] = 1 / w; jv[6] = -v * x / w; jv[7] = -v * y / w;
            return [u, v];
        };
        let ss = 0;
        for (let i = 0; i < n; i++) {
            const [u, v] = jac((src[2 * i] - cx) / k, (src[2 * i + 1] - cy) / k);
            ss += (u - (dst[2 * i] - cx) / k) ** 2 + (v - (dst[2 * i + 1] - cy) / k) ** 2;
            for (let a = 0; a < 8; a++) for (let b = 0; b < 8; b++) N[a * 8 + b] += ju[a] * ju[b] + jv[a] * jv[b];
        }
        const Ni = invert(N, 8);
        if (!Ni) return Infinity;
        let worst = 0;
        const ay = (size.h - 1) / 2 / k;
        for (const [x, y] of [[-1, -ay], [1, -ay], [1, ay], [-1, ay]]) {
            jac(x, y);
            let q = 0;
            for (let a = 0; a < 8; a++) for (let b = 0; b < 8; b++) q += Ni[a * 8 + b] * (ju[a] * ju[b] + jv[a] * jv[b]);
            worst = Math.max(worst, q);
        }
        return Math.sqrt(ss / Math.max(1, 2 * n - 8) * worst) * k;
    }

    // Inverse of an n×n matrix (row-major), or null when it has none (Gauss-Jordan, pivoting).
    function invert(M, n) {
        const A = Float64Array.from(M), I = new Float64Array(n * n);
        for (let i = 0; i < n; i++) I[i * n + i] = 1;
        for (let c = 0; c < n; c++) {
            let piv = c;
            for (let r = c + 1; r < n; r++) if (Math.abs(A[r * n + c]) > Math.abs(A[piv * n + c])) piv = r;
            const d = A[piv * n + c];
            if (!(Math.abs(d) > 1e-14)) return null;
            if (piv !== c) for (let j = 0; j < n; j++) { [A[c * n + j], A[piv * n + j]] = [A[piv * n + j], A[c * n + j]]; [I[c * n + j], I[piv * n + j]] = [I[piv * n + j], I[c * n + j]]; }
            for (let j = 0; j < n; j++) { A[c * n + j] /= d; I[c * n + j] /= d; }
            for (let r = 0; r < n; r++) {
                if (r === c) continue;
                const f = A[r * n + c];
                if (!f) continue;
                for (let j = 0; j < n; j++) { A[r * n + j] -= f * A[c * n + j]; I[r * n + j] -= f * I[c * n + j]; }
            }
        }
        return I;
    }

    // Least-squares similarity (shift, rotation, scale) through point pairs, as a homography.
    function similarity(src, dst) {
        const n = src.length / 2;
        let mx = 0, my = 0, ux = 0, uy = 0;
        for (let i = 0; i < src.length; i += 2) { mx += src[i]; my += src[i + 1]; ux += dst[i]; uy += dst[i + 1]; }
        mx /= n; my /= n; ux /= n; uy /= n;
        let a = 0, b = 0, d = 0;
        for (let i = 0; i < src.length; i += 2) {
            const x = src[i] - mx, y = src[i + 1] - my, u = dst[i] - ux, v = dst[i + 1] - uy;
            a += x * u + y * v; b += x * v - y * u; d += x * x + y * y;
        }
        if (!(d > 0)) return null;
        const c = a / d, s = b / d;                          // [c −s; s c]
        return [c, -s, ux - c * mx + s * my, s, c, uy - s * mx - c * my, 0, 0, 1];
    }

    // Motion from `prev` to `cur` (CV_8UC1 Mats of the same size; `prev` is the frame the
    // current points live in). Returns
    //   { ok, reason, H (small-frame px, prev → cur, or null), tracked, inliers, ratio,
    //     points: Float32Array x y x' y' state … (state 1 inlier used for the fit, 2 inlier not
    //     followed precisely enough to be used, 0 outlier, −1 failed LK / FB),
    //     used: inliers the final fit is made of, fbLimit: their forward-backward limit (px),
    //     cornerStd: how well they pin the fit down (px at the corners), model: 'similarity' when
    //     the simpler fit was used }
    function update(prev, cur) {
        frameNo++;
        if (!size || size.w !== prev.cols || size.h !== prev.rows) {
            size = { w: prev.cols, h: prev.rows };
            pts = new Float32Array(0);
            cellRetry = [];
        }
        const n0 = pts.length / 2;
        if (n0 < p.reseedBelow) seed(prev, true);
        else seed(prev, false);

        const n = pts.length / 2;
        const result = { ok: false, reason: null, H: null, tracked: 0, inliers: 0, ratio: 0, points: new Float32Array(0) };
        if (n < 8) {
            result.reason = 'too few features';
            pts = new Float32Array(0);
            return result;
        }

        const p0 = cv.matFromArray(n, 1, cv.CV_32FC2, pts);
        const p1 = new cv.Mat(), pb = new cv.Mat();
        const st1 = new cv.Mat(), st2 = new cv.Mat(), err1 = new cv.Mat(), err2 = new cv.Mat();
        const src = [], dst = [], idx = [], fb = [];
        let H = null, inlierMask = null;
        try {
            const win = new cv.Size(p.lkWin, p.lkWin);
            const crit = new cv.TermCriteria(cv.TermCriteria_COUNT | cv.TermCriteria_EPS, p.lkIters, p.lkEps);
            cv.calcOpticalFlowPyrLK(prev, cur, p0, p1, st1, err1, win, p.lkLevels, crit);
            cv.calcOpticalFlowPyrLK(cur, prev, p1, pb, st2, err2, win, p.lkLevels, crit);
            const a = p0.data32F, b = p1.data32F, c = pb.data32F;
            result.points = new Float32Array(n * 5);
            for (let i = 0; i < n; i++) {
                const o = i * 5;
                result.points[o] = a[2 * i]; result.points[o + 1] = a[2 * i + 1];
                result.points[o + 2] = b[2 * i]; result.points[o + 3] = b[2 * i + 1];
                result.points[o + 4] = -1;
                if (!st1.data[i] || !st2.data[i]) continue;
                const d = Math.hypot(c[2 * i] - a[2 * i], c[2 * i + 1] - a[2 * i + 1]);
                if (!(d <= p.fbMax)) continue;
                const x = b[2 * i], y = b[2 * i + 1];
                if (x < 0 || y < 0 || x > size.w - 1 || y > size.h - 1) continue;
                if (excluded(a[2 * i], a[2 * i + 1]) || excluded(x, y)) continue;
                src.push(a[2 * i], a[2 * i + 1]);
                dst.push(x, y);
                idx.push(i);
                fb.push(d);
            }
            result.tracked = idx.length;
            if (idx.length < 8) {
                result.reason = 'too few tracked points';
            } else {
                inlierMask = new cv.Mat();
                H = fit(src, dst, cv.RANSAC, inlierMask);
            }
        } finally {
            [p0, p1, pb, st1, st2, err1, err2].forEach(m => m.delete());
        }

        // which points agree with the fit; of those, the ones followed precisely (see the top of
        // the file) give the fit its final form and are the next frame's points
        const keep = [];
        if (H && inlierMask) {
            const inl = [];
            for (let j = 0; j < idx.length; j++) if (inlierMask.data[j]) inl.push(j);
            result.inliers = inl.length;
            let limit = p.fbMax;
            if (p.fbRel > 0 && inl.length >= 8) {
                const sorted = inl.map(j => fb[j]).sort((u, v) => u - v);
                const ref = sorted[Math.min(Math.floor(sorted.length * FB_QUANTILE), Math.max(8, p.minInliers) - 1)];
                limit = Math.min(p.fbMax, Math.max(p.fbFloor, p.fbRel * ref));
            }
            result.fbLimit = limit;
            const used = inl.filter(j => fb[j] <= limit);
            for (const j of inl) result.points[idx[j] * 5 + 4] = fb[j] <= limit ? 1 : 2;
            for (let j = 0; j < idx.length; j++) if (!inlierMask.data[j]) result.points[idx[j] * 5 + 4] = 0;
            result.used = used.length;
            const us = used.flatMap(j => [src[2 * j], src[2 * j + 1]]), ud = used.flatMap(j => [dst[2 * j], dst[2 * j + 1]]);
            if (used.length >= 8 && used.length < inl.length) {
                const H1 = fit(us, ud, 0, null);
                if (H1 && !implausible(H1, size.w, size.h)) H = H1;
            }
            result.cornerStd = cornerSpread(H, us, ud);
            // points in a thin band don't pin a full fit down over the rest of the frame
            if (p.loose > 0 && used.length >= 8 && result.cornerStd > p.loose * size.w / 320) {
                const H1 = similarity(us, ud);
                if (H1 && !implausible(H1, size.w, size.h)) { H = H1; result.model = 'similarity'; }
            }
            for (const j of used) keep.push(dst[2 * j], dst[2 * j + 1]);
        }
        if (inlierMask) inlierMask.delete();
        result.ratio = result.tracked ? result.inliers / result.tracked : 0;
        if (H) Object.assign(result, fitQuality(H, src, dst, result.points, idx));

        if (!result.reason) {
            if (!H) result.reason = 'no homography';
            else if (result.inliers < p.minInliers) result.reason = 'too few inliers';
            else if (result.ratio < p.minInlierRatio) result.reason = 'low inlier ratio';
            else result.reason = implausible(H, size.w, size.h);
        }
        result.ok = !result.reason;
        if (result.ok) {
            result.H = H;
            // a cell whose new points all went (flat sky: noise for corners) rests for a while
            if (seeded.size && p.fbRel > 0) {
                const held = new Set();
                for (let j = 0; j < keep.length; j += 2) held.add(cellOf(keep[j], keep[j + 1]));
                for (const cell of seeded) if (!held.has(cell)) cellRetry[cell] = frameNo + p.retryEmptyAfter;
            }
        }
        // after a failure, start afresh on the next frame
        pts = result.ok ? new Float32Array(keep) : new Float32Array(0);
        return result;
    }

    return {
        update,
        reset() { pts = new Float32Array(0); cellRetry = []; },
        setParams(next) {
            const regrid = next.gridCols !== p.gridCols || next.gridRows !== p.gridRows;
            p = { ...p, ...next };
            if (regrid) { pts = new Float32Array(0); cellRetry = []; }
        },
        get params() { return p; },
        dispose() { none.delete(); },
    };
}
