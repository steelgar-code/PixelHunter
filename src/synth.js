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
    // [{ x, y, w, h, every? }] screen-fixed overlays, frame px: dark panel with bright 2×2
    // blocks; the right half of the blocks changes every `every` frames (default 1)
    osd: [],
    // { size, contrast, vx, vy, ax?, ay?, from?, to? } plus a start position: x, y in world
    // coordinates or fx, fy in frame `from`'s coordinates. Velocities in world px per frame.
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

    // world raster: covers every frame of the scene, plus a margin
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let k = 0; k < s.frames; k++) {
        const Gi = inv(pose(k));
        for (const [x, y] of [[-1, -1], [W, -1], [W, H], [-1, H]]) {
            const [u, v] = project(Gi, x, y);
            minX = Math.min(minX, u); maxX = Math.max(maxX, u);
            minY = Math.min(minY, v); maxY = Math.max(maxY, v);
        }
    }
    const ox = Math.floor(minX) - 4, oy = Math.floor(minY) - 4;
    const ww = Math.ceil(maxX) + 4 - ox, wh = Math.ceil(maxY) + 4 - oy;
    const world = makeWorld(ww, wh, rand, s);
    const noiseSeed = Math.floor(rand() * 2 ** 32);

    // targets given in frame coordinates start where that frame sees them
    const targets = s.targets.map(t => {
        if (t.fx === undefined) return t;
        const [x, y] = project(inv(pose(t.from ?? 0)), t.fx, t.fy);
        return { ...t, x, y };
    });

    function targetAt(t, k) {
        const from = t.from ?? 0, to = t.to ?? Infinity;
        if (k < from || k > to) return null;
        const dt = k - from;
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
            const [cx, cy] = project(G, p[0], p[1]);
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
        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
                const d = Gi[6] * x + Gi[7] * y + Gi[8];
                let u = (Gi[0] * x + Gi[1] * y + Gi[2]) / d - ox;
                let v = (Gi[3] * x + Gi[4] * y + Gi[5]) / d - oy;
                u = Math.min(ww - 1.001, Math.max(0, u));
                v = Math.min(wh - 1.001, Math.max(0, v));
                const iu = Math.floor(u), iv = Math.floor(v), fu = u - iu, fv = v - iv;
                const i = iv * ww + iu;
                const top = world[i] + (world[i + 1] - world[i]) * fu;
                const bot = world[i + ww] + (world[i + ww + 1] - world[i + ww]) * fu;
                out[y * W + x] = top + (bot - top) * fv;
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
