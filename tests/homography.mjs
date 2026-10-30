// homography.js (Node only).
import { ok } from './lib/env.mjs';
import { mul, inv, normalize, project, corners, scaleH, scaleMatrix, maxCornerDiff, implausible, IDENTITY } from '../src/homography.js';

const close = (a, b, eps = 1e-9) => a.every((v, i) => Math.abs(v - b[i]) < eps);
const rot = (a, s = 1, tx = 0, ty = 0) => [Math.cos(a) * s, -Math.sin(a) * s, tx, Math.sin(a) * s, Math.cos(a) * s, ty, 0, 0, 1];

const H = mul([1, 0, 0, 0, 1, 0, 3e-6, -2e-6, 1], rot(0.02, 1.01, 7.5, -3.25));
ok('H · H⁻¹ = I', close(normalize(mul(H, inv(H))), IDENTITY, 1e-12));
ok('singular matrix has no inverse', inv([1, 2, 3, 2, 4, 6, 0, 0, 1]) === null);
ok('project applies the perspective divide', close(project([2, 0, 1, 0, 2, 1, 0, 0, 2], 3, 4), [3.5, 4.5]));
ok('corners are the outer pixel edges', JSON.stringify(corners(IDENTITY, 4, 2)) === JSON.stringify([[-0.5, -0.5], [3.5, -0.5], [3.5, 1.5], [-0.5, 1.5]]));

// A transform built at full resolution, expressed in small-image coordinates (pixel-area
// aligned resize by k), and scaled back up, maps full-resolution points the same way.
for (const k of [2, 4, 1280 / 320, 1920 / 320]) {
    const A = scaleMatrix(k);
    const Hs = normalize(mul(mul(inv(A), H), A));
    const back = scaleH(Hs, k);
    ok(`scaleH(k = ${k.toFixed(2)}) recovers the full-resolution transform`, maxCornerDiff(back, H, 1920, 1080) < 1e-6);
    // and a point seen in the small image maps where the full transform puts it
    const [x, y] = [1000, 500];
    const [sx, sy] = [(x + 0.5) / k - 0.5, (y + 0.5) / k - 0.5];
    const [qx, qy] = project(Hs, sx, sy);
    const [fx, fy] = project(H, x, y);
    ok(`small-image mapping agrees with full (k = ${k.toFixed(2)})`, Math.hypot((qx + 0.5) * k - 0.5 - fx, (qy + 0.5) * k - 0.5 - fy) < 1e-6);
}
// plain S·H·S⁻¹ without the pixel-centre offset is off for rotations; scaleH is not
const S = [4, 0, 0, 0, 4, 0, 0, 0, 1];
const R = rot(0.05);
ok('pixel-centre offset matters for rotation', maxCornerDiff(normalize(mul(mul(S, R), inv(S))), scaleH(R, 4), 1280, 720) > 0.05);
ok('… and not for pure translation', maxCornerDiff(normalize(mul(mul(S, rot(0, 1, 3, 2)), inv(S))), scaleH(rot(0, 1, 3, 2), 4), 1280, 720) < 1e-9);

ok('maxCornerDiff of a 2 px shift', Math.abs(maxCornerDiff(rot(0, 1, 2, 0), IDENTITY, 640, 360) - 2) < 1e-9);
ok('identity is plausible', implausible(IDENTITY, 320, 180) === null);
ok('small motion is plausible', implausible(H, 320, 180) === null);
ok('NaN rejected', implausible([NaN, 0, 0, 0, 1, 0, 0, 0, 1], 320, 180) === 'no valid fit');
ok('mirror rejected', implausible([-1, 0, 319, 0, 1, 0, 0, 0, 1], 320, 180) !== null);
ok('3× zoom rejected', implausible(rot(0, 3), 320, 180) === 'implausible scale change');
ok('folded perspective rejected', implausible([1, 0, 0, 0, 1, 0, 0.01, 0, 1], 320, 180) !== null);
ok('half-frame jump rejected', implausible(rot(0, 1, 160, 0), 320, 180) === 'motion too large');

// Composition order over several frames (stride > 1): checked against exact ground truth of a
// scene whose per-frame motions don't commute (rotation, zoom, perspective, translation).
{
    const { composeNewestFirst } = await import('../src/homography.js');
    const { createScene } = await import('../src/synth.js');
    // each frame turns, zooms and shifts by a different amount, so the steps don't commute
    const camera = k => ({ cx: 8 * k + 15 * Math.sin(k * 1.3), cy: 10 * Math.cos(k * 0.9), rot: 0.04 * Math.sin(k * 1.7), scale: 1 + 0.03 * Math.sin(k * 1.1), px: 2e-5 * Math.sin(k), py: 0 });
    const s = createScene({ width: 640, height: 360, frames: 12, camera, seed: 3 });
    const corners = [[0, 0], [639, 0], [639, 359], [0, 359]];
    const err = (A, B) => Math.max(...corners.map(([x, y]) => { const [a, b] = project(A, x, y), [c, d] = project(B, x, y); return Math.hypot(a - c, b - d); }));
    for (const n of [2, 3, 6, 10]) {
        const t = 11;
        const fits = [];                                         // newest first: H(t−1→t), H(t−2→t−1), …
        for (let k = t; k > t - n; k--) fits.push(s.truth(k).H);
        const exact = mul(s.pose(t), inv(s.pose(t - n)));        // world → t after frame t−n → world
        const reversed = fits.slice().reverse().reduce((H, Hi) => mul(H, Hi), [1, 0, 0, 0, 1, 0, 0, 0, 1]);
        ok(`composition over ${n} frames matches the exact t−${n} → t mapping`, err(composeNewestFirst(fits), exact) < 1e-6, err(composeNewestFirst(fits), exact));
        ok(`… and the opposite order would be off by pixels (the test can tell)`, err(reversed, exact) > 1, +err(reversed, exact).toFixed(3));
    }
}
