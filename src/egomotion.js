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
// Points inside exclusion zones (zones.js) are neither seeded nor used: an overlay fixed on
// screen tracks as "no motion" and would pull the fit towards the identity. Zones are grown by
// half the LK window, since a point next to a zone's edge is tracked with the overlay in view.

import { implausible, normalize } from './homography.js';
import { inZones } from './zones.js';

export const EGO_DEFAULTS = {
    features: 400,         // point budget, split over the grid
    gridCols: 8,
    gridRows: 6,
    minDistance: 5,        // px between corners (small frame)
    quality: 0.01,         // goodFeaturesToTrack quality level
    lkWin: 21,             // LK window, px (odd)
    lkLevels: 3,           // pyramid levels above the base image
    fbMax: 1,              // forward-backward round trip, px
    reseedBelow: 100,      // fewer tracked points than this: seed the whole grid again
    ransacPx: 2,           // RANSAC reprojection threshold, small-frame px
    minInliers: 30,
    minInlierRatio: 0.5,
    retryEmptyAfter: 10,   // frames before re-trying a cell where no corner was found
    zones: [],             // exclusion zones, { x, y, w, h } fractions of the frame
};

export function createEgomotion(cv, options = {}) {
    let p = { ...EGO_DEFAULTS, ...options };
    let pts = new Float32Array(0);     // tracked points in the latest frame, x0 y0 x1 y1 …
    let size = null;                   // { w, h } of the small frames
    let cellRetry = [];                // frame number before which an empty cell isn't re-seeded
    let frameNo = 0;

    const none = new cv.Mat();

    function cellOf(x, y) {
        const c = Math.min(p.gridCols - 1, Math.floor(x / size.w * p.gridCols));
        const r = Math.min(p.gridRows - 1, Math.floor(y / size.h * p.gridRows));
        return r * p.gridCols + c;
    }

    // Adds corners to cells with fewer than a third of their share (all cells when `all`).
    function seed(img, all) {
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

    // { err50, err90 (small px), coverage } of a fit, from its inliers
    function fitQuality(H, src, dst, points, idx) {
        const errs = [];
        const tracked = new Set(), covered = new Set();
        for (let j = 0; j < idx.length; j++) {
            const cell = cellOf(src[2 * j], src[2 * j + 1]);
            tracked.add(cell);
            if (points[idx[j] * 5 + 4] !== 1) continue;
            covered.add(cell);
            const x = src[2 * j], y = src[2 * j + 1];
            const d = H[6] * x + H[7] * y + H[8];
            errs.push(Math.hypot((H[0] * x + H[1] * y + H[2]) / d - dst[2 * j], (H[3] * x + H[4] * y + H[5]) / d - dst[2 * j + 1]));
        }
        errs.sort((a, b) => a - b);
        const q = f => (errs.length ? errs[Math.min(errs.length - 1, Math.floor(errs.length * f))] : null);
        return { err50: q(0.5), err90: q(0.9), coverage: tracked.size ? covered.size / tracked.size : 0 };
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

    // Motion from `prev` to `cur` (CV_8UC1 Mats of the same size; `prev` is the frame the
    // current points live in). Returns
    //   { ok, reason, H (small-frame px, prev → cur, or null), tracked, inliers, ratio,
    //     points: Float32Array x y x' y' state … (state 1 inlier, 0 outlier, −1 failed LK / FB) }
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
        const src = [], dst = [], idx = [];
        let H = null, inlierMask = null;
        try {
            const win = new cv.Size(p.lkWin, p.lkWin);
            const crit = new cv.TermCriteria(cv.TermCriteria_COUNT | cv.TermCriteria_EPS, 30, 0.01);
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
                const fb = Math.hypot(c[2 * i] - a[2 * i], c[2 * i + 1] - a[2 * i + 1]);
                if (!(fb <= p.fbMax)) continue;
                const x = b[2 * i], y = b[2 * i + 1];
                if (x < 0 || y < 0 || x > size.w - 1 || y > size.h - 1) continue;
                if (excluded(a[2 * i], a[2 * i + 1]) || excluded(x, y)) continue;
                src.push(a[2 * i], a[2 * i + 1]);
                dst.push(x, y);
                idx.push(i);
            }
            result.tracked = idx.length;
            if (idx.length < 8) {
                result.reason = 'too few tracked points';
            } else {
                const sm = cv.matFromArray(idx.length, 1, cv.CV_32FC2, src);
                const dm = cv.matFromArray(idx.length, 1, cv.CV_32FC2, dst);
                inlierMask = new cv.Mat();
                try {
                    const Hm = cv.findHomography(sm, dm, cv.RANSAC, p.ransacPx, inlierMask);
                    if (Hm.rows === 3 && Hm.cols === 3) H = normalize(Array.from(Hm.data64F));
                    Hm.delete();
                } finally {
                    sm.delete();
                    dm.delete();
                }
            }
        } finally {
            [p0, p1, pb, st1, st2, err1, err2].forEach(m => m.delete());
        }

        // next frame's points: the inliers, where they landed
        const keep = [];
        if (H && inlierMask) {
            for (let j = 0; j < idx.length; j++) {
                const inl = inlierMask.data[j] ? 1 : 0;
                result.points[idx[j] * 5 + 4] = inl;
                if (inl) { result.inliers++; keep.push(dst[2 * j], dst[2 * j + 1]); }
            }
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
        if (result.ok) result.H = H;
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
