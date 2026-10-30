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
// Adaptive mode (three frames, for faint objects): the same comparison with t−s and t+s, but
//   - frame t and both warped neighbours are blurred alike (3×3 Gaussian): warping by a fraction
//     of a pixel softens fine texture and hard edges, the unwarped frame t isn't, and without
//     this the difference shows the resampling instead of what moved; an object a few px across
//     loses peak contrast but not its sum, which is what is thresholded (below);
//   - a tolerance for misalignment that follows how good the camera-motion fit is: each pixel
//     is compared with the warped neighbour's value moved a fraction e of the way towards its
//     3×3 max (or min), e = tolBase + TOL_PER_ERR × the fit's 90th-percentile error, clamped to
//     [tolBase, 1]. e = 1 is the robust mode's full 3×3 min / max (1 px of misalignment); a
//     good fit gives a much smaller allowance, which in textured areas is the difference between
//     a faint object being cancelled and being seen;
//   - the object must be brighter (or darker) than both neighbours: R = the smaller of the two
//     differences when they agree in sign, else 0;
//   - R is summed over 1×1, 2×2 and 3×3 px, so an object a few px across counts as a whole
//     instead of pixel by pixel (the sum's noise grows with the side, its signal with the
//     area);
//   - the threshold follows the local noise: σ of the plain difference is measured in tiles of
//     NOISE_TILE px (median absolute value), and a pixel is a candidate where any of the sums
//     exceeds `sigmas` times its own noise there. Quiet sky gets a low threshold, textured or
//     compressed areas a higher one; `minContrast` is the floor (grey levels, 1×1);
//   - at hard edges the noise is raised in proportion to how steep the neighbourhood is beyond
//     ordinary texture (edgeNoise × (3×3 spread − edgeKnee)): what is left of misalignment and
//     resampling there grows with the edge, so a hard edge needs a larger difference to count,
//     while textured ground keeps its sensitivity;
//   - slivers along edges are dropped: when a straight edge turns a little, the stair-steps of
//     its pixels slide along it fast, which looks like a thin object moving steadily. A
//     candidate at least SLIVER_ELONGATION times longer than wide, lying along a strong, clean
//     edge of the background (structure tensor of the warped neighbour: coherence ≥
//     SLIVER_COHERENCE, edge within SLIVER_ANGLE of the candidate's long axis), is not an object;
//   - candidates come in two strengths: strong (peak above `sigmas`) and weak (above sigmas −
//     weakMargin). Only strong ones can start a track; weak ones can only continue a track that
//     already exists (tracker.js), so a faint object, once found, is followed through frames
//     where it barely shows, while marginal noise can't start anything.
//
// Exclusion zones (zones.js) are cleared from the valid region in frame t and also where each
// compared frame's zones land once warped onto t: an overlay fixed on screen sits somewhere
// else in the stabilised neighbours, and would show up there as a difference too.
//
// Background-shift check (option): a candidate on the edge of something that doesn't follow the
// ground exactly (a treetop closer to the camera, a branch in the wind) is the background sitting
// slightly off, not an object moving on its own. For each candidate, the ring of background
// around it is matched against each warped neighbour at shifts up to ±shiftMax px; if the shift
// that best aligns the ring also makes the candidate's own pixels match (same 3×3 min / max test,
// under the threshold), the candidate is dropped. A real mover isn't explained that way: the
// background around it lines up with no shift (or the shift of the trees behind it), and the
// object is somewhere else in the other frames. Surroundings without texture (sky) give no shift
// to go by, so candidates there are kept.
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
const RING = 5;                // px of background around a candidate for the shift check
const RING_TEXTURE = 1.5;      // grey levels: ring cost must vary at least this much over shifts
const SHIFT_KEEP = 0.25;       // a candidate stays if more than this share of its pixels still differ
const SHIFT_TOL = 1;           // px: min / max reach when testing the shifted pixels (2 loses real targets)
const NOISE_TILE = 32;         // px: tiles in which the adaptive mode measures noise
const SUM_NOISE = 0.61;        // σ of a k×k sum of R, per k, in units of σ of the plain difference
const TOL_PER_ERR = 2;         // … plus this × the fit's 90th-percentile point error (px)
const SHIFT_EXPLAINS = 0.35;   // adaptive shift check: explained if the shift leaves < this share
const SLIVER_ELONGATION = 3;   // long axis / short axis of a candidate's pixels
const SLIVER_COHERENCE = 0.6;  // (λ1 − λ2) / (λ1 + λ2) of the background's gradients: a clean edge
const SLIVER_ANGLE = 25 * Math.PI / 180;
const SLIVER_GRADIENT = 8;     // grey levels per px: weaker than this isn't an edge

export const DETECT_DEFAULTS = {
    detectMode: 'robust',  // 'robust' (three frames, M3), 'adaptive' (three frames) or 'basic' (two)
    threshold: 20,         // grey levels (robust, basic)
    sigmas: 5,             // adaptive: threshold in units of the local noise
    minContrast: 4,        // adaptive: lowest threshold, grey levels
    weakMargin: 1.5,       // adaptive: weak candidates down to sigmas − this (0: none)
    noiseFrom: 'plain',    // adaptive: noise scaled from the plain difference ('plain', calibrated),
                           // or each k×k sum's own RMS ('sums': underestimates the tails of these
                           // non-Gaussian sums; on the benchmark false tracks went into the thousands)
    tolBase: 0.05,         // adaptive: px of misalignment always allowed
    edgeNoise: 0.06,       // adaptive: σ added per grey level of 3×3 spread beyond edgeKnee
    edgeKnee: 0,           // adaptive: grey levels of 3×3 spread that are just texture
    minArea: 1,            // px (processing resolution)
    maxArea: 400,
    borderMargin: 3,       // px kept clear inside the warped frame's outline
    mergeDist: 2,          // blobs whose boxes are this close (px) become one candidate
    maxCandidates: 1000,   // more than this: keep the first ones, flag the frame as noisy
    brightness: true,      // match the neighbours' mean brightness to frame t (robust mode)
    blur: false,           // 3×3 Gaussian blur before differencing (robust mode)
    open: false,           // 3×3 opening of the final mask (removes 1–2 px blobs!)
    shiftCheck: false,     // drop candidates explained by a small local shift of the background
    shiftMax: 2,           // px: largest local shift tried
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
    let lastTol = null;        // adaptive mode: misalignment allowance of the last detection, px

    function setup(w, h) {
        for (const k of Object.keys(m)) { m[k].delete(); delete m[k]; }
        size = { w, h };
        for (const k of ['warped', 'diff', 'mask', 'valid', 'labels', 'stats', 'centroids',
            'ero', 'dil', 'tmp', 'dNext', 'mPrev', 'valid2', 'curBlur', 'sWarp', 'sValid', 'inc', 'wPrev', 'wNext']) m[k] = new cv.Mat();
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
    function minMaxDiff(ref, H, offset, cur, out, w = m.warped) {
        warp(ref, H, w, cur.cols, cur.rows);
        if (offset) w.convertTo(w, -1, 1, offset);
        if (p.blur) cv.GaussianBlur(w, w, new cv.Size(3, 3), 0);
        cv.erode(w, m.ero, k3);
        cv.dilate(w, m.dil, k3);
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

    // Is candidate c (full-frame px) explained by a local shift of the background? cur: frame t
    // as { data, step, ox, oy } (region pixel (x, y) at data[(y + oy) * step + x + ox]); ns: the
    // warped neighbours (region-sized Mats); mask: the region's detection mask.
    // thrAt: per-pixel threshold (robust / basic: a pixel still differs above it), or null for the
    // adaptive mode's relative test: explained when the shift leaves less than SHIFT_EXPLAINS of
    // the candidate's summed difference (faint objects never pass a per-pixel threshold).
    function shiftExplained(c, r, cur, ns, mask, thrAt = () => p.threshold) {
        const S = Math.max(1, Math.round(p.shiftMax));
        const bx0 = c.x - r.x, by0 = c.y - r.y, bx1 = bx0 + c.w, by1 = by0 + c.h;     // box, exclusive end
        // the window must leave room for the shifts and the 3×3 min / max inside the region
        const lo = S + SHIFT_TOL;
        const wx0 = Math.max(lo, bx0 - RING), wy0 = Math.max(lo, by0 - RING);
        const wx1 = Math.min(r.w - lo, bx1 + RING), wy1 = Math.min(r.h - lo, by1 + RING);
        if (wx0 > bx0 - 2 || wy0 > by0 - 2 || wx1 < bx1 + 2 || wy1 < by1 + 2) return false;  // at the edge: keep
        const cd = cur.data, cs = cur.step, M = mask.data;
        const C = (x, y) => cd[(y + cur.oy) * cs + x + cur.ox];
        for (const n of ns) {
            const nd = n.data, W = r.w;
            let best = Infinity, worst = 0, bdx = 0, bdy = 0;
            for (let dy = -S; dy <= S; dy++) {
                for (let dx = -S; dx <= S; dx++) {
                    let sum = 0, cnt = 0;
                    for (let y = wy0; y < wy1; y++) {
                        const inRows = y >= by0 - 1 && y <= by1;
                        for (let x = wx0; x < wx1; x++) {
                            if (inRows && x >= bx0 - 1 && x <= bx1) continue;            // the ring only
                            sum += Math.abs(C(x, y) - nd[(y + dy) * W + x + dx]);
                            cnt++;
                        }
                    }
                    const cost = sum / cnt + 0.05 * (Math.abs(dx) + Math.abs(dy));     // ties: the smaller shift
                    if (cost < best) { best = cost; bdx = dx; bdy = dy; }
                    if (cost > worst) worst = cost;
                }
            }
            if (worst - best < RING_TEXTURE) return false;     // nothing to align on: keep
            if (!thrAt) {
                if (bdx === 0 && bdy === 0) return false;       // the background lines up as it is
                const residual = (sx, sy) => {
                    let sum = 0;
                    for (let y = by0; y < by1; y++) {
                        for (let x = bx0; x < bx1; x++) {
                            if (!M[y * W + x]) continue;
                            let mn = 255, mx = 0;
                            for (let yy = y + sy - SHIFT_TOL; yy <= y + sy + SHIFT_TOL; yy++) {
                                for (let xx = x + sx - SHIFT_TOL; xx <= x + sx + SHIFT_TOL; xx++) {
                                    const v = nd[yy * W + xx];
                                    if (v < mn) mn = v;
                                    if (v > mx) mx = v;
                                }
                            }
                            const v = C(x, y);
                            sum += Math.max(0, v - mx) + Math.max(0, mn - v);
                        }
                    }
                    return sum;
                };
                const r0 = residual(0, 0);
                if (!(r0 > 0) || residual(bdx, bdy) >= SHIFT_EXPLAINS * r0) return false;
                continue;
            }
            let bad = 0, total = 0;
            for (let y = by0; y < by1; y++) {
                for (let x = bx0; x < bx1; x++) {
                    if (!M[y * W + x]) continue;
                    total++;
                    let mn = 255, mx = 0;
                    for (let yy = y + bdy - SHIFT_TOL; yy <= y + bdy + SHIFT_TOL; yy++) {
                        for (let xx = x + bdx - SHIFT_TOL; xx <= x + bdx + SHIFT_TOL; xx++) {
                            const v = nd[yy * W + xx];
                            if (v < mn) mn = v;
                            if (v > mx) mx = v;
                        }
                    }
                    const v = C(x, y);
                    if (Math.max(0, v - mx) + Math.max(0, mn - v) > thrAt(x, y)) bad++;
                }
            }
            if (!total || bad > total * SHIFT_KEEP) return false;
        }
        return true;
    }

    // Is candidate c (region px) a sliver along an edge of the background `w` (region-sized)?
    function isSliver(c, r, w, mask) {
        const x0 = c.x - r.x, y0 = c.y - r.y, x1 = x0 + c.w, y1 = y0 + c.h;
        if (Math.max(c.w, c.h) < 4) return false;                       // too small to tell
        const M = mask.data, W = r.w;
        // the candidate's own shape: second moments of its pixels
        let n = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
            if (!M[y * W + x]) continue;
            n++; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
        }
        if (n < 3) return false;
        const mx = sx / n, my = sy / n;
        const a = sxx / n - mx * mx + 1 / 12, b = sxy / n - mx * my, d = syy / n - my * my + 1 / 12;
        const tr = a + d, det = a * d - b * b, disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
        const l1 = tr / 2 + disc, l2 = Math.max(1e-6, tr / 2 - disc);
        if (Math.sqrt(l1 / l2) < SLIVER_ELONGATION) return false;
        const axis = 0.5 * Math.atan2(2 * b, a - d);                    // long axis
        // the background's gradients around it (structure tensor, box grown by 1)
        const wd = w.data;
        let gxx = 0, gyy = 0, gxy = 0, m = 0;
        for (let y = Math.max(1, y0 - 1); y < Math.min(r.h - 1, y1 + 1); y++) {
            for (let x = Math.max(1, x0 - 1); x < Math.min(r.w - 1, x1 + 1); x++) {
                const gx = (wd[y * W + x + 1] - wd[y * W + x - 1]) / 2, gy = (wd[(y + 1) * W + x] - wd[(y - 1) * W + x]) / 2;
                gxx += gx * gx; gyy += gy * gy; gxy += gx * gy; m++;
            }
        }
        if (!m || Math.sqrt((gxx + gyy) / m) < SLIVER_GRADIENT) return false;
        const coh = Math.sqrt((gxx - gyy) ** 2 + 4 * gxy * gxy) / (gxx + gyy);
        if (coh < SLIVER_COHERENCE) return false;
        const edge = 0.5 * Math.atan2(2 * gxy, gxx - gyy) + Math.PI / 2;  // along the edge
        let diff = Math.abs(axis - edge) % Math.PI;
        if (diff > Math.PI / 2) diff = Math.PI - diff;
        return diff <= SLIVER_ANGLE;
    }

    // Splits a region's candidates into kept and explained by a background shift.
    function shiftFilter(b, r, src, view, full, ns, thrAt) {
        if (!p.shiftCheck || !b.candidates.length) return { ...b, rejected: [] };
        const cur = src !== view ? { data: src.data, step: r.w, ox: 0, oy: 0 }
            : full ? { data: view.data, step: r.w, ox: 0, oy: 0 }
            : { data: src.__full.data, step: size.w, ox: r.x, oy: r.y };
        const kept = [], rejected = [];
        for (const c of b.candidates) (shiftExplained(c, r, cur, ns, m.mask, thrAt) ? rejected : kept).push(c);
        return { ...b, candidates: kept, rejected };
    }

    // Frame t inside region r ({ x, y, w, h }, processing px): a view of `cur` and the
    // translation from full-frame to region coordinates.
    function regionOf(cur, r) {
        const full = r.x === 0 && r.y === 0 && r.w === size.w && r.h === size.h;
        const view = full ? cur : cur.roi(new cv.Rect(r.x, r.y, r.w, r.h));
        if (!full) view.__full = cur;      // an ROI's own data isn't contiguous: read through the frame
        return { view, full, T: [1, 0, -r.x, 0, 1, -r.y, 0, 0, 1] };
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
            warp(prev, Hp, m.wPrev, r.w, r.h);
            cv.absdiff(view, m.wPrev, m.diff);
            cv.threshold(m.diff, m.mask, p.threshold, 255, cv.THRESH_BINARY);
            regionValid(r, T, [Hp]);
            cv.bitwise_and(m.mask, m.valid, m.mask);
            if (!full) keepViews(r, m.diff);
            return shiftFilter(blobs(m.mask, r.x, r.y), r, view, view, full, [m.wPrev]);
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
            minMaxDiff(prev, Hp, off[0], src, m.diff, m.wPrev);
            minMaxDiff(next, Hn, off[1], src, m.dNext, m.wNext);
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
            return shiftFilter(blobs(m.mask, r.x, r.y), r, src, view, full, [m.wPrev, m.wNext]);
        } finally {
            if (!full) view.delete();
        }
    }

    // Warps a neighbour onto region r of frame t, with its brightness offset (and blur).
    function warpNeighbour(ref, H, offset, w, cols, rows, blur = p.blur) {
        warp(ref, H, w, cols, rows);
        if (offset) w.convertTo(w, -1, 1, offset);
        if (blur) cv.GaussianBlur(w, w, new cv.Size(3, 3), 0);
    }

    // σ of the plain difference D (CV_32F, region-sized) per NOISE_TILE tile, from the median
    // absolute value, as a region-sized CV_32F map (bilinear between tile centres) in m.sig.
    function noiseMap(D, r) {
        const tx = Math.max(1, Math.round(r.w / NOISE_TILE)), ty = Math.max(1, Math.round(r.h / NOISE_TILE));
        const d = D.data32F, hist = new Uint32Array(256), sig = new Float32Array(tx * ty);
        for (let j = 0; j < ty; j++) {
            const y0 = Math.floor(j * r.h / ty), y1 = Math.floor((j + 1) * r.h / ty);
            for (let i = 0; i < tx; i++) {
                const x0 = Math.floor(i * r.w / tx), x1 = Math.floor((i + 1) * r.w / tx);
                hist.fill(0);
                for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) hist[Math.min(255, Math.abs(d[y * r.w + x]) | 0)]++;
                const half = ((y1 - y0) * (x1 - x0)) / 2;
                let acc = 0, med = 0;
                while (med < 255 && acc + hist[med] < half) acc += hist[med++];
                // the histogram bins whole grey levels: interpolate inside the median bin
                const frac = hist[med] ? (half - acc) / hist[med] : 0.5;
                sig[j * tx + i] = 1.4826 * (med + frac);
            }
        }
        const t = cv.matFromArray(ty, tx, cv.CV_32F, Array.from(sig));
        cv.resize(t, m.sig, new cv.Size(r.w, r.h), 0, 0, cv.INTER_LINEAR);
        t.delete();
        // floor: the 1×1 threshold is at least minContrast
        m.sigFloor ??= new cv.Mat();
        m.sigFloor.create(r.h, r.w, cv.CV_32F);
        m.sigFloor.setTo(new cv.Scalar(p.minContrast / (p.sigmas * SUM_NOISE)));
        cv.max(m.sig, m.sigFloor, m.sig);
    }

    // Per NOISE_TILE tile, the RMS of S (CV_32F, region-sized) with values above 3.5× a first RMS
    // left out (targets, edges), as a region-sized map in `out`, at least `floor`.
    function tileRms(S, r, out, floor) {
        const tx = Math.max(1, Math.round(r.w / NOISE_TILE)), ty = Math.max(1, Math.round(r.h / NOISE_TILE));
        const d = S.data32F, sig = new Array(tx * ty);
        for (let j = 0; j < ty; j++) {
            const y0 = Math.floor(j * r.h / ty), y1 = Math.floor((j + 1) * r.h / ty);
            for (let i = 0; i < tx; i++) {
                const x0 = Math.floor(i * r.w / tx), x1 = Math.floor((i + 1) * r.w / tx);
                let s2 = 0, n = 0;
                for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const v = d[y * r.w + x]; s2 += v * v; n++; }
                const cap = 3.5 * Math.sqrt(s2 / n), cap2 = cap * cap;
                let t2 = 0, m = 0;
                for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const v = d[y * r.w + x]; if (v * v <= cap2) { t2 += v * v; m++; } }
                sig[j * tx + i] = Math.max(floor, m ? Math.sqrt(t2 / m) : floor);
            }
        }
        const t = cv.matFromArray(ty, tx, cv.CV_32F, sig);
        cv.resize(t, out, new cv.Size(r.w, r.h), 0, 0, cv.INTER_LINEAR);
        t.delete();
    }

    // The adaptive detector on region r (see the top of the file).
    function detectAdaptive(prev, cur, next, Hprev, Hnext, off, r, fitErr) {
        const { view, full, T } = regionOf(cur, r);
        for (const k of ['dP', 'dN', 'hi', 'lo', 'sig', 'pos', 'neg', 'R', 'S', 'Z', 'Zk', 'tmp2', 'zero', 'spread', 'spread2']) m[k] ??= new cv.Mat();
        try {
            const Hp = mul(T, Hprev), Hn = mul(T, inv(Hnext));
            // all three blurred alike (always, in this mode)
            cv.GaussianBlur(view, m.curBlur, new cv.Size(3, 3), 0);
            const src = m.curBlur;
            warpNeighbour(prev, Hp, off[0], m.wPrev, r.w, r.h, true);
            warpNeighbour(next, Hn, off[1], m.wNext, r.w, r.h, true);
            const none = new cv.Mat();
            try {
                // the noise, from the plain difference with t−s
                cv.subtract(src, m.wPrev, m.dP, none, cv.CV_32F);
                noiseMap(m.dP, r);
                // signed differences beyond the misalignment allowance: (cur − hi)⁺ − (lo − cur)⁺,
                // hi / lo = the neighbour moved a fraction e towards its 3×3 max / min
                const base = p.tolBase;
                const e = Math.min(1, Math.max(base, base + TOL_PER_ERR * (fitErr ?? 0.35)));
                lastTol = e;
                let first = true;
                for (const [w, D] of [[m.wPrev, m.dP], [m.wNext, m.dN]]) {
                    cv.dilate(w, m.dil, k3);
                    cv.erode(w, m.ero, k3);
                    // steepest neighbourhood of the two neighbours, for the edge term
                    cv.subtract(m.dil, m.ero, first ? m.spread : m.spread2);
                    if (!first) cv.max(m.spread, m.spread2, m.spread);
                    first = false;
                    cv.addWeighted(w, 1 - e, m.dil, e, 0, m.hi, cv.CV_32F);
                    cv.addWeighted(w, 1 - e, m.ero, e, 0, m.lo, cv.CV_32F);
                    cv.subtract(src, m.hi, m.pos, none, cv.CV_32F);
                    cv.threshold(m.pos, m.pos, 0, 0, cv.THRESH_TOZERO);
                    cv.subtract(m.lo, src, m.neg, none, cv.CV_32F);
                    cv.threshold(m.neg, m.neg, 0, 0, cv.THRESH_TOZERO);
                    cv.subtract(m.pos, m.neg, D);
                }
            } finally {
                none.delete();
            }
            // edges: σ² += (edgeNoise × (spread − edgeKnee)⁺)², kept squared in m.spread2
            const { edgeNoise, edgeKnee } = p;
            const sums = p.noiseFrom === 'sums';
            if (edgeNoise > 0) {
                m.spread.convertTo(m.spread2, cv.CV_32F, edgeNoise, -edgeNoise * edgeKnee);
                cv.threshold(m.spread2, m.spread2, 0, 0, cv.THRESH_TOZERO);
                cv.multiply(m.spread2, m.spread2, m.spread2);
                if (!sums) {
                    cv.multiply(m.sig, m.sig, m.sig);
                    cv.add(m.sig, m.spread2, m.sig);
                    cv.sqrt(m.sig, m.sig);
                }
            }
            // R: brighter (or darker) than both neighbours, by the smaller amount
            cv.threshold(m.dP, m.pos, 0, 0, cv.THRESH_TOZERO);
            cv.threshold(m.dN, m.tmp2, 0, 0, cv.THRESH_TOZERO);
            cv.min(m.pos, m.tmp2, m.pos);
            cv.threshold(m.dP, m.neg, 0, 0, cv.THRESH_TOZERO_INV);
            cv.threshold(m.dN, m.tmp2, 0, 0, cv.THRESH_TOZERO_INV);
            cv.max(m.neg, m.tmp2, m.neg);
            cv.add(m.pos, m.neg, m.R);
            // Z: the strongest of the 1×1, 2×2 and 3×3 sums, in units of their own noise
            m.zero.create(r.h, r.w, cv.CV_32F);
            m.zero.setTo(new cv.Scalar(0));
            m.sigK ??= new cv.Mat();
            m.edgeK ??= new cv.Mat();
            for (const k of [1, 2, 3]) {
                if (k === 1) m.R.copyTo(m.S);
                else cv.boxFilter(m.R, m.S, cv.CV_32F, new cv.Size(k, k), new cv.Point(-1, -1), false);
                if (sums) {
                    // this sum's own noise, per tile, plus the edge term at its scale
                    tileRms(m.S, r, m.sigK, k * p.minContrast / p.sigmas);
                    if (edgeNoise > 0) {
                        m.spread2.convertTo(m.edgeK, cv.CV_32F, (SUM_NOISE * k) ** 2);
                        cv.multiply(m.sigK, m.sigK, m.sigK);
                        cv.add(m.sigK, m.edgeK, m.sigK);
                        cv.sqrt(m.sigK, m.sigK);
                    }
                    cv.absdiff(m.S, m.zero, m.S);
                    cv.divide(m.S, m.sigK, m.Zk, 1);
                } else {
                    cv.absdiff(m.S, m.zero, m.S);
                    cv.divide(m.S, m.sig, m.Zk, 1 / (SUM_NOISE * k));
                }
                if (k === 1) m.Zk.copyTo(m.Z); else cv.max(m.Z, m.Zk, m.Z);
            }
            const weakAt = Math.max(1, p.sigmas - Math.max(0, p.weakMargin || 0));
            cv.threshold(m.Z, m.tmp2, weakAt, 255, cv.THRESH_BINARY);
            m.tmp2.convertTo(m.mask, cv.CV_8U);
            regionValid(r, T, [Hp, Hn]);
            cv.bitwise_and(m.mask, m.valid, m.mask);
            if (p.open) cv.morphologyEx(m.mask, m.mask, cv.MORPH_OPEN, k3);
            // debug views: |R| × 4 as the difference
            cv.absdiff(m.R, m.zero, m.tmp2);
            m.tmp2.convertTo(m.diff, cv.CV_8U);
            if (!full) keepViews(r, m.diff);
            const b = blobs(m.mask, r.x, r.y);
            // each candidate's strength: the peak Z in its box
            const z = m.Z.data32F;
            for (const c of b.candidates) {
                let peak = 0;
                for (let y = c.y - r.y; y < c.y - r.y + c.h; y++) for (let x = c.x - r.x; x < c.x - r.x + c.w; x++) peak = Math.max(peak, z[y * r.w + x]);
                c.score = peak;
            }
            // slivers along edges: dropped, shown with the shift-check rejects
            const slivers = b.candidates.filter(c => isSliver(c, r, m.wPrev, m.mask));
            if (slivers.length) b.candidates = b.candidates.filter(c => !slivers.includes(c));
            const f = shiftFilter(b, r, src, view, full, [m.wPrev, m.wNext], null);
            f.rejected = [...(f.rejected || []), ...slivers];
            f.slivers = slivers.length;
            return { ...f, candidates: f.candidates.filter(c => c.score >= p.sigmas),
                weak: f.candidates.filter(c => c.score < p.sigmas).map(c => ({ ...c, weak: true })) };
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
        if (mode === 'robust' || mode === 'adaptive') {
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
        const out = { candidates: [], weak: [], rejected: [], components: 0, noisy: false };
        for (const r of regions || [{ x: 0, y: 0, w: size.w, h: size.h }]) {
            const b = mode === 'robust'
                ? detectRobust(args.prev, args.cur, args.next, args.Hprev, args.Hnext, brightness, r)
                : mode === 'adaptive'
                    ? detectAdaptive(args.prev, args.cur, args.next, args.Hprev, args.Hnext, brightness, r, args.fitErr)
                    : detectBasic(args.prev, args.cur, args.Hprev, r);
            out.candidates.push(...b.candidates);
            out.rejected.push(...b.rejected);
            if (b.weak) out.weak.push(...b.weak);
            out.slivers = (out.slivers || 0) + (b.slivers || 0);
            out.components += b.components;
            out.noisy ||= b.noisy;
        }
        if (out.candidates.length > p.maxCandidates) { out.candidates.length = p.maxCandidates; out.noisy = true; }
        const t1 = performance.now();
        return { ...out, shiftRejected: out.rejected.length, ...(brightness ? { brightness } : {}), regions: regions || null,
            ...(mode === 'adaptive' ? { tolerance: lastTol } : {}),
            processedArea: regions ? regions.reduce((a, r) => a + r.w * r.h, 0) / (size.w * size.h) : 1,
            timings: { diff: t1 - t0 } };
    }

    return {
        // { prev, cur, next } grey Mats, { Hprev, Hnext } (t−1→t, t→t+1), and `small`: the same
        // frames and H at estimation size (for brightness matching). Returns
        // { ok, reason, mode, candidates, components, noisy, brightness?, timings }.
        // fitErr: the camera-motion fits' error over the compared frames (processing px; adaptive).
        detect({ prev, cur, next, Hprev, Hnext, small, fitErr }) {
            if (!size || size.w !== cur.cols || size.h !== cur.rows) setup(cur.cols, cur.rows);
            if (!prev || !Hprev) return { ok: false, reason: 'no camera motion for t−1 → t', candidates: [] };
            lastMode = p.detectMode;
            if (p.detectMode === 'basic') return { ok: true, reason: null, mode: 'basic', ...run('basic', { prev, cur, Hprev }) };
            if (!next || !Hnext) return { ok: false, reason: 'no camera motion for t → t+1', candidates: [] };
            const mode = p.detectMode === 'adaptive' ? 'adaptive' : 'robust';
            return { ok: true, reason: null, mode, ...run(mode, { prev, cur, next, Hprev, Hnext, small, fitErr }) };
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
                if (lastMode === 'adaptive') {
                    m.diff.convertTo(m.view, -1, 4, 0);
                } else if (lastMode === 'robust') {
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
