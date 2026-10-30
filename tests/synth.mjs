// synth.js (Node only): determinism, ground truth and target rendering.
import { ok } from './lib/env.mjs';
import { createScene, mulberry32 } from '../src/synth.js';
import { mul, inv, normalize, project, maxCornerDiff } from '../src/homography.js';

const a = createScene({ width: 160, height: 90, frames: 10, camera: 'handheld', seed: 7 });
const b = createScene({ width: 160, height: 90, frames: 10, camera: 'handheld', seed: 7 });
const c = createScene({ width: 160, height: 90, frames: 10, camera: 'handheld', seed: 8 });
const fa = a.frame(5), fb = b.frame(5), fc = c.frame(5);
ok('same seed, same frame', fa.grey.every((v, i) => v === fb.grey[i]));
ok('other seed, other frame', fc.grey.some((v, i) => v !== fa.grey[i]));
ok('PRNG in [0, 1)', (() => { const r = mulberry32(3); for (let i = 0; i < 1000; i++) { const x = r(); if (!(x >= 0 && x < 1)) return false; } return true; })());

for (const camera of ['pan', 'drone', 'handheld']) {
    const s = createScene({ width: 320, height: 180, frames: 30, camera });
    let worst = 0;
    for (let k = 1; k < 30; k++) {
        const H = s.truth(k).H;
        worst = Math.max(worst, maxCornerDiff(H, normalize(mul(s.pose(k), inv(s.pose(k - 1)))), 320, 180));
    }
    ok(`${camera}: truth H(k−1 → k) = G_k·G_{k−1}⁻¹`, worst < 1e-9);
}

// a world point lands where the truth H says, from one frame to the next
{
    const s = createScene({ width: 320, height: 180, frames: 5, camera: 'drone' });
    const p = project(s.pose(2), 30, -20);
    const q = project(s.truth(3).H, p[0], p[1]);
    const r = project(s.pose(3), 30, -20);
    ok('truth H moves world points between frames', Math.hypot(q[0] - r[0], q[1] - r[1]) < 1e-9);
}

// a 3×3 target adds contrast × 9 in total, centred on its truth box
{
    const base = { width: 160, height: 90, frames: 3, camera: 'static', noise: 0 };
    const t = { size: 3, contrast: 40, fx: 80.3, fy: 40.6, vx: 0, vy: 0 };
    const plain = createScene(base).frame(1).grey;
    const withT = createScene({ ...base, targets: [t] }).frame(1);
    let sum = 0, mx = 0, my = 0;
    for (let i = 0; i < plain.length; i++) {
        const d = withT.grey[i] - plain[i];
        sum += d; mx += d * (i % 160); my += d * Math.floor(i / 160);
    }
    const box = withT.truth.targets[0];
    ok('target adds contrast × area', Math.abs(sum - 40 * 9) <= 9, sum);
    ok('target centroid matches the truth box', Math.hypot(mx / sum - box.cx, my / sum - box.cy) < 0.15, [mx / sum, my / sum, box.cx, box.cy]);
    ok('target given in frame coordinates starts there', Math.hypot(box.cx - 80.3, box.cy - 40.6) < 1e-6);
}

// targets move in the world, leave the truth when out of view or outside from..to
{
    const s = createScene({ width: 160, height: 90, frames: 20, camera: 'pan', targets: [{ size: 2, contrast: 50, fx: 150, fy: 45, vx: 12, vy: 0, from: 2, to: 12 }] });
    // the camera pans 6 px/frame, the target 12: it drifts right by 6 px/frame in the frame
    ok('target absent before `from`', s.truth(1).targets.length === 0);
    ok('target present from `from`', s.truth(2).targets.length === 1);
    ok('target leaves the truth when it leaves the frame', s.truth(4).targets.length === 0);
    const t = createScene({ width: 160, height: 90, frames: 20, camera: 'static', targets: [{ size: 2, contrast: 50, fx: 50, fy: 45, vx: 1, vy: 0, to: 5 }] });
    ok('target absent after `to`', t.truth(5).targets.length === 1 && t.truth(6).targets.length === 0);
}

// exposure ramp and noise
{
    const base = { width: 64, height: 36, frames: 20, camera: 'static', noise: 0 };
    const s0 = createScene(base), s1 = createScene({ ...base, exposure: { from: 0, to: 10, gain: 20 } });
    const mean = g => g.reduce((x, y) => x + y, 0) / g.length;
    ok('exposure ramp shifts the mean by `gain`', Math.abs(mean(s1.frame(15).grey) - mean(s0.frame(15).grey) - 20) < 1);
    const n = createScene({ ...base, noise: 5 }).frame(3).grey, z = s0.frame(3).grey;
    const sd = Math.sqrt(n.reduce((acc, v, i) => acc + (v - z[i]) ** 2, 0) / n.length);
    ok('noise has the requested σ', Math.abs(sd - 5) < 0.6, sd);
}
