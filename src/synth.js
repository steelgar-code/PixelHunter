// Synthetic moving-camera scenes with exact ground truth. Pure and seeded: the same scenario
// gives the same frames in the browser and in Node.
//
// A scene is a textured "world" image seen through a camera whose pose per frame is a
// homography G_k (world → frame k); the world is made just large enough for every frame of the
// scene. World coordinates have their origin at the centre of frame 0. Targets move in world
// coordinates; each is a small square drawn on top with area-weighted edges. Frames are grey,
// with optional sensor noise, exposure drift and blur.
//
// Ground truth per frame: H (frame k−1 → frame k, = G_k·G_{k−1}⁻¹) and each target's box.
// An optional OSD (text-like blocks fixed on screen, part of them changing every few frames)
// is drawn over everything, like a drone's telemetry overlay; targets under it are hidden.
// Optional "trees": leafy, hard-edged discs that don't follow the ground exactly: closer to the
// camera (parallax: they drift against the ground as the camera moves) and swaying in the wind.
// They are background, not targets: anything detected on them is a false positive.
//
// Camera artefacts a homography can't describe, as on real drones and phones: `lens` (radial
// barrel distortion: the frame corners show this much more of the scene, 0.05 = 5 %) and
// `rollingShutter` (rows are exposed one after another over this fraction of a frame, top
// first, so a turning camera skews the picture), and `motionBlur` (exposure time as a fraction
// of a frame: the background is averaged over the camera's motion during it, so edges smear by
// more when the camera moves faster). Targets follow lens and rolling shutter (and are drawn
// sharp); trees and the ground truth H follow none (H stays the ideal camera's).

import { mul, inv, project } from './homography.js';

export function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function gaussian(rand) {
    let u = 0;
    while (u === 0) u = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

const smooth = t => t * t * (3 - 2 * t);

// Multi-octave value noise around 128, plus optional hard-edged shapes.
function makeWorld(w, h, rand, { octaves, shapes }) {
    const img = new Float32Array(w * h).fill(128);
    for (const [cell, amp] of octaves) {
        const gw = Math.ceil(w / cell) + 2, gh = Math.ceil(h / cell) + 2;
        const grid = new Float32Array(gw * gh);
        for (let i = 0; i < grid.length; i++) grid[i] = (rand() - 0.5) * 2 * amp;
        for (let y = 0; y < h; y++) {
            const gy = y / cell, iy = Math.floor(gy), fy = smooth(gy - iy);
            for (let x = 0; x < w; x++) {
                const gx = x / cell, ix = Math.floor(gx), fx = smooth(gx - ix);
                const i0 = iy * gw + ix, i1 = i0 + gw;
                const top = grid[i0] + (grid[i0 + 1] - grid[i0]) * fx;
                const bot = grid[i1] + (grid[i1 + 1] - grid[i1]) * fx;
                img[y * w + x] += top + (bot - top) * fy;
            }
        }
    }
    for (let n = 0; n < shapes; n++) {
        const sw = 10 + rand() * 80, sh = 10 + rand() * 80;
        const x0 = Math.floor(rand() * (w - sw)), y0 = Math.floor(rand() * (h - sh));
        const v = 30 + rand() * 195, round = rand() < 0.5;
        for (let y = y0; y < y0 + sh; y++) {
            for (let x = x0; x < x0 + sw; x++) {
                if (round) {
                    const dx = (x - x0) / sw - 0.5, dy = (y - y0) / sh - 0.5;
                    if (dx * dx + dy * dy > 0.25) continue;
                }
                img[y * w + x] = v;
            }
        }
    }
    return img;
}

// Camera motions, as functions of the frame index k returning pose parameters:
// { cx, cy } world point at the frame centre, rot (rad), scale, px / py perspective (1/px).
export const CAMERAS = {
    static: () => ({ cx: 0, cy: 0, rot: 0, scale: 1, px: 0, py: 0 }),
    pan: k => ({ cx: 6 * k, cy: 2.5 * k, rot: 0, scale: 1, px: 0, py: 0 }),
    drone: k => ({ cx: 4 * k, cy: -1.5 * k, rot: 0.003 * k, scale: 1 + 0.002 * k, px: 2e-7 * k, py: 1e-7 * k }),
    handheld: k => ({
        cx: 3 * k + 4 * Math.sin(k * 0.9) + 2 * Math.sin(k * 2.3),
        cy: 3 * Math.sin(k * 0.7 + 1) + 2 * Math.sin(k * 1.9),
        rot: 0.01 * Math.sin(k * 0.5), scale: 1 + 0.01 * Math.sin(k * 0.2), px: 0, py: 0,
    }),
    // strong handheld shake: larger jitter, quicker roll
    shake: k => ({
        cx: 3 * k + 10 * Math.sin(k * 0.9) + 5 * Math.sin(k * 2.3),
        cy: 7 * Math.sin(k * 0.7 + 1) + 5 * Math.sin(k * 1.9),
        rot: 0.025 * Math.sin(k * 0.6), scale: 1 + 0.015 * Math.sin(k * 0.25), px: 0, py: 0,
    }),
    // a drone turning while it flies: steady pan with a continuous roll of ~0.3° a frame
    turn: k => ({ cx: 4 * k, cy: 1.5 * Math.sin(k * 0.3), rot: 0.005 * k, scale: 1, px: 1e-7 * Math.sin(k * 0.2), py: 0 }),
    // a fast yaw (about 40°/s on a wide lens: 12–16 px a frame, speeding up and slowing down)
    // with a slow roll
    yaw: k => ({ cx: 14 * k + 25 * Math.sin(k * 0.12), cy: 2 * Math.sin(k * 0.4), rot: 0.003 * k, scale: 1, px: 0, py: 0 }),
};

export const DEFAULT_SCENE = {
    width: 640,
    height: 360,
    frames: 60,
    fps: 25,
    seed: 1,
    camera: 'pan',
    octaves: [[96, 70], [32, 50], [10, 35], [3, 20]],
    shapes: 0,                 // hard-edged rectangles / discs in the world
    noise: 2,                  // sensor noise σ, grey levels
    exposure: null,            // { from, to, gain } ramp: offset grows by `gain` grey levels between frames from..to
    blur: false,               // 3×3 box blur of each frame
    lens: 0,                   // radial barrel distortion at the frame corners (0.05 = 5 %)
    rollingShutter: 0,         // readout time top to bottom, fraction of a frame
    motionBlur: 0,             // exposure time, fraction of a frame (background smear)
    // [{ x, y, w, h, every? }] screen-fixed overlays, frame px: dark panel with bright 2×2
    // blocks; the right half of the blocks changes every `every` frames (default 1)
    osd: [],
    // [{ x, y (world, or fx, fy in frame 0), r (px), parallax? (0.1 = 10 % closer-than-ground
    // drift), sway? (px), swayPeriod? (frames), dark? }]
    trees: [],
    // { fy (horizon: row in frame 0), level (grey at the horizon), gradient (grey levels brighter
    // per 100 px up), haze (amplitude of faint large-scale clouds) }: above the horizon the
    // world is smooth sky instead of texture, the flat kind of area video compression flattens
    sky: null,
    // { size, contrast, vx, vy, ax?, ay?, from?, to?, stops? } plus a start position: x, y in
    // world coordinates or fx, fy in frame `from`'s coordinates. Velocities in world px per
    // frame. stops: [[k0, k1], …] frames during which the target stands still (stop and go).
    targets: [],
};

export function createScene(options = {}) {
    const s = { ...DEFAULT_SCENE, ...options };
    const { width: W, height: H } = s;
    const rand = mulberry32(s.seed);
    const camera = typeof s.camera === 'function' ? s.camera : CAMERAS[s.camera];

    // world → frame k
    function pose(k) {
        const p = camera(k);
        const c = Math.cos(p.rot) * p.scale, n = Math.sin(p.rot) * p.scale;
        const toCentre = [1, 0, -p.cx, 0, 1, -p.cy, 0, 0, 1];
        const rs = [c, -n, 0, n, c, 0, 0, 0, 1];
        const persp = [1, 0, 0, 0, 1, 0, p.px, p.py, 1];
        const toFrame = [1, 0, (W - 1) / 2, 0, 1, (H - 1) / 2, 0, 0, 1];
        return mul(toFrame, mul(persp, mul(rs, toCentre)));
    }

    // lens: observed pixel → where an ideal (pinhole) camera would see it; r = 1 at the corners
    const lcx = (W - 1) / 2, lcy = (H - 1) / 2, R2 = lcx * lcx + lcy * lcy;
    const ideal = (x, y) => {
        if (!s.lens) return [x, y];
        const f = 1 + s.lens * ((x - lcx) ** 2 + (y - lcy) ** 2) / R2;
        return [lcx + (x - lcx) * f, lcy + (y - lcy) * f];
    };
    // … and back: ideal → observed (fixed-point iteration, converges for small distortion)
    const observed = (u, v) => {
        if (!s.lens) return [u, v];
        let x = u, y = v;
        for (let i = 0; i < 8; i++) {
            const f = 1 + s.lens * ((x - lcx) ** 2 + (y - lcy) ** 2) / R2;
            x = lcx + (u - lcx) / f; y = lcy + (v - lcy) / f;
        }
        return [x, y];
    };
    // rolling shutter: when row y of frame k is exposed
    const rowTime = (k, y) => k + s.rollingShutter * ((y + 0.5) / H - 0.5);

    // world raster: covers every frame of the scene (every row's exposure time), plus a margin
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let k = 0; k < s.frames; k++) {
        for (const [x, y, e] of [[-1, -1, -1], [W, -1, -1], [W, H, -1], [-1, H, -1], [-1, -1, 1], [W, -1, 1], [W, H, 1], [-1, H, 1]]) {
            const Gi = inv(pose(rowTime(k, y) + e * (s.motionBlur || 0) / 2));
            const [u, v] = project(Gi, ...ideal(x, y));
            minX = Math.min(minX, u); maxX = Math.max(maxX, u);
            minY = Math.min(minY, v); maxY = Math.max(maxY, v);
        }
    }
    const ox = Math.floor(minX) - 4, oy = Math.floor(minY) - 4;
    const ww = Math.ceil(maxX) + 4 - ox, wh = Math.ceil(maxY) + 4 - oy;
    const world = makeWorld(ww, wh, rand, s);
    if (s.sky) {
        const { fy, level = 175, gradient = 6, haze = 3 } = s.sky;
        const horizon = project(inv(pose(0)), (W - 1) / 2, fy)[1] - oy;      // raster row
        const clouds = makeWorld(ww, wh, rand, { octaves: [[128, haze], [48, haze / 2]], shapes: 0 });
        for (let y = 0; y < Math.min(wh, Math.floor(horizon)); y++) {
            const v = level + gradient * (horizon - y) / 100;
            for (let x = 0; x < ww; x++) world[y * ww + x] = v + clouds[y * ww + x] - 128;
        }
    }
    const noiseSeed = Math.floor(rand() * 2 ** 32);
    const trees = s.trees.map((t, n) => makeTree(t, n, s.seed, inv(pose(0)), camera));

    // targets given in frame coordinates start where that frame sees them
    const targets = s.targets.map(t => {
        if (t.fx === undefined) return t;
        const [x, y] = project(inv(pose(t.from ?? 0)), t.fx, t.fy);
        return { ...t, x, y };
    });

    function targetAt(t, k) {
        const from = t.from ?? 0, to = t.to ?? Infinity;
        if (k < from || k > to) return null;
        let dt = k - from;
        for (const [a, b] of t.stops || []) dt -= Math.max(0, Math.min(k, b) - Math.max(a, from));
        return [t.x + t.vx * dt + 0.5 * (t.ax || 0) * dt * dt, t.y + t.vy * dt + 0.5 * (t.ay || 0) * dt * dt];
    }

    // Ground truth for frame k: H(k−1 → k) and the boxes of the targets in view.
    function truth(k) {
        const G = pose(k);
        const Hk = k > 0 ? mul(G, inv(pose(k - 1))) : null;
        const inView = [];
        targets.forEach((t, id) => {
            const p = targetAt(t, k);
            if (!p) return;
            let [cx, cy] = project(G, p[0], p[1]);
            if (s.rollingShutter || s.lens) {
                // seen at its own row's exposure time, through the lens
                for (let i = 0; i < 3; i++) {
                    const kk = rowTime(k, cy), q = targetAt(t, kk) || p;
                    [cx, cy] = observed(...project(pose(kk), q[0], q[1]));
                }
            }
            const half = t.size / 2;
            const box = { id, cx, cy, x: cx - half, y: cy - half, w: t.size, h: t.size };
            const hidden = s.osd.some(o => box.x + box.w > o.x && box.x < o.x + o.w && box.y + box.h > o.y && box.y < o.y + o.h);
            if (box.x >= 0 && box.y >= 0 && box.x + box.w <= W - 1 && box.y + box.h <= H - 1 && !hidden) inView.push(box);
        });
        return { k, H: Hk && Hk.map(v => v / Hk[8]), targets: inView };
    }

    // Frame k as grey levels (Uint8ClampedArray, W×H) plus its ground truth.
    function frame(k) {
        const Gi = inv(pose(k));
        const out = new Float32Array(W * H);
        // motion blur: the average of `n` instants spread over the exposure
        const n = s.motionBlur > 0 ? 7 : 1;
        for (let j = 0; j < n; j++) {
            const dt = n > 1 ? s.motionBlur * (j / (n - 1) - 0.5) : 0;
            const Gj = dt ? inv(pose(k + dt)) : Gi;
            for (let y = 0; y < H; y++) {
                const Gr = s.rollingShutter ? inv(pose(rowTime(k, y) + dt)) : Gj;
                for (let x = 0; x < W; x++) {
                    const [xi, yi] = s.lens ? ideal(x, y) : [x, y];
                    const d = Gr[6] * xi + Gr[7] * yi + Gr[8];
                    let u = (Gr[0] * xi + Gr[1] * yi + Gr[2]) / d - ox;
                    let v = (Gr[3] * xi + Gr[4] * yi + Gr[5]) / d - oy;
                    u = Math.min(ww - 1.001, Math.max(0, u));
                    v = Math.min(wh - 1.001, Math.max(0, v));
                    const iu = Math.floor(u), iv = Math.floor(v), fu = u - iu, fv = v - iv;
                    const i = iv * ww + iu;
                    const top = world[i] + (world[i + 1] - world[i]) * fu;
                    const bot = world[i + ww] + (world[i + ww + 1] - world[i + ww]) * fu;
                    out[y * W + x] += (top + (bot - top) * fv) / n;
                }
            }
        }
        const t = truth(k);
        // pixel x covers [x − 0.5, x + 0.5]; add the target in proportion to the area covered
        for (const box of t.targets) {
            const amp = targets[box.id].contrast;
            for (let y = Math.floor(box.y); y <= Math.ceil(box.y + box.h); y++) {
                const cy = Math.min(y + 0.5, box.y + box.h) - Math.max(y - 0.5, box.y);
                if (cy <= 0) continue;
                for (let x = Math.floor(box.x); x <= Math.ceil(box.x + box.w); x++) {
                    const cx = Math.min(x + 0.5, box.x + box.w) - Math.max(x - 0.5, box.x);
                    if (cx > 0) out[y * W + x] += amp * cx * cy;
                }
            }
        }
        for (const t of trees) drawTree(out, W, H, t, k, Gi, pose(k));
        s.osd.forEach((o, n) => drawOsd(out, W, H, o, k, s.seed * 131 + n));
        if (s.blur) boxBlur3(out, W, H);
        if (s.exposure) {
            const { from, to, gain } = s.exposure;
            const f = Math.min(1, Math.max(0, (k - from) / Math.max(1, to - from)));
            for (let i = 0; i < out.length; i++) out[i] += gain * f;
        }
        const grey = new Uint8ClampedArray(W * H);
        if (s.noise > 0) {
            const nr = mulberry32(noiseSeed + k * 7919);
            for (let i = 0; i < out.length; i++) grey[i] = out[i] + s.noise * gaussian(nr);
        } else {
            for (let i = 0; i < out.length; i++) grey[i] = out[i];
        }
        return { grey, width: W, height: H, truth: t };
    }

    return { options: s, width: W, height: H, frames: s.frames, fps: s.fps, pose, truth, frame };
}

// A tree: a disc of leafy texture (dark, with bright speckles), its own seed.
function makeTree(t, n, seed, G0i, camera) {
    let x = t.x, y = t.y;
    if (t.fx !== undefined) [x, y] = project(G0i, t.fx, t.fy);
    const r = t.r, size = Math.ceil(2 * r + 3);
    const rand = mulberry32(seed * 977 + n * 31 + 5);
    const tex = new Float32Array(size * size);
    const base = t.dark === false ? 170 : 55;
    for (let i = 0; i < tex.length; i++) tex[i] = base + (rand() - 0.5) * 50 + (rand() < 0.08 ? 90 : 0);
    // soften the speckle a little (leaves are a few px across)
    const soft = tex.slice();
    for (let yy = 1; yy < size - 1; yy++) for (let xx = 1; xx < size - 1; xx++) {
        const i = yy * size + xx;
        soft[i] = (tex[i] * 2 + tex[i - 1] + tex[i + 1] + tex[i - size] + tex[i + size]) / 6;
    }
    const c0 = camera(0);
    return { x, y, r, size, tex: soft, parallax: t.parallax || 0, sway: t.sway || 0, period: t.swayPeriod || 40, phase: rand() * 6.28, camera, c0 };
}

// Tree centre in world coordinates at frame k: parallax drifts it against the camera's motion,
// sway moves it back and forth.
function treeAt(t, k) {
    const c = t.camera(k);
    const w = Math.sin(2 * Math.PI * k / t.period + t.phase) * t.sway;
    return [t.x - t.parallax * (c.cx - t.c0.cx) + w, t.y - t.parallax * (c.cy - t.c0.cy) + 0.3 * w];
}

function drawTree(img, W, H, t, k, Gi, G) {
    const [tx, ty] = treeAt(t, k);
    const [fx, fy] = project(G, tx, ty);
    const reach = t.r * 1.2 + 2;
    const x0 = Math.max(0, Math.floor(fx - reach)), x1 = Math.min(W - 1, Math.ceil(fx + reach));
    const y0 = Math.max(0, Math.floor(fy - reach)), y1 = Math.min(H - 1, Math.ceil(fy + reach));
    const half = (t.size - 1) / 2;
    for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
            const [u, v] = project(Gi, x, y);
            const dx = u - tx, dy = v - ty, d = Math.hypot(dx, dy);
            if (d > t.r + 0.5) continue;
            const a = Math.min(1, t.r + 0.5 - d);          // antialiased edge
            const tu = Math.min(t.size - 1.001, Math.max(0, dx + half)), tv = Math.min(t.size - 1.001, Math.max(0, dy + half));
            const iu = Math.floor(tu), iv = Math.floor(tv), fu = tu - iu, fv = tv - iv, i = iv * t.size + iu;
            const top = t.tex[i] + (t.tex[i + 1] - t.tex[i]) * fu;
            const bot = t.tex[i + t.size] + (t.tex[i + t.size + 1] - t.tex[i + t.size]) * fu;
            const val = top + (bot - top) * fv;
            img[y * W + x] = img[y * W + x] * (1 - a) + val * a;
        }
    }
}

function drawOsd(img, W, H, o, k, seed) {
    const x0 = Math.max(0, Math.round(o.x)), y0 = Math.max(0, Math.round(o.y));
    const x1 = Math.min(W, Math.round(o.x + o.w)), y1 = Math.min(H, Math.round(o.y + o.h));
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) img[y * W + x] = 25;
    const epoch = Math.floor(k / (o.every || 1));
    const cols = Math.floor((x1 - x0 - 4) / 3), rows = Math.floor((y1 - y0 - 4) / 3);
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const changing = c >= cols / 2;
            const on = mulberry32(seed * 7907 + r * 1009 + c * 17 + (changing ? epoch * 104729 : 0))() < 0.45;
            if (!on) continue;
            const bx = x0 + 2 + c * 3, by = y0 + 2 + r * 3;
            for (let y = by; y < by + 2; y++) for (let x = bx; x < bx + 2; x++) img[y * W + x] = 230;
        }
    }
}

function boxBlur3(img, w, h) {
    const src = img.slice();
    for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
            let sum = 0;
            for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) sum += src[(y + dy) * w + x + dx];
            img[y * w + x] = sum / 9;
        }
    }
}

// Grey levels → RGBA bytes (for ImageData).
export function greyToRgba(grey, out = new Uint8ClampedArray(grey.length * 4)) {
    for (let i = 0, j = 0; i < grey.length; i++, j += 4) {
        out[j] = out[j + 1] = out[j + 2] = grey[i];
        out[j + 3] = 255;
    }
    return out;
}
