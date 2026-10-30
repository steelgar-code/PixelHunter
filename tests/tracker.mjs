// tracker.js (Node only): confirmation on scripted blob sequences.
import { ok } from './lib/env.mjs';
import { createTracker } from '../src/tracker.js';
import { mulberry32 } from '../src/synth.js';

const blob = (cx, cy, s = 3) => ({ cx, cy, x: Math.round(cx - s / 2), y: Math.round(cy - s / 2), w: s, h: s, area: s * s });
const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const confirmedIds = tracks => tracks.filter(t => t.state === 'confirmed' && t.matched).map(t => t.id);

{
    const tr = createTracker();
    const states = [];
    for (let k = 0; k < 6; k++) states.push(tr.step([blob(100 + 4 * k, 50 + 2 * k)], I));
    ok('seen every frame: confirmed at the 3rd sighting, not before', confirmedIds(states[1]).length === 0 && confirmedIds(states[2]).length === 1, states.map(s => confirmedIds(s)));
    ok('one track, one id throughout', new Set(states.flatMap(s => s.map(t => t.id))).size === 1);
    const t = states[5][0];
    ok('velocity estimated', Math.abs(t.vx - 4) < 0.2 && Math.abs(t.vy - 2) < 0.2, [t.vx, t.vy]);
}
{
    const tr = createTracker();
    let ever = false;
    // seen at frames 0, 3, 6, … : at most 2 of any 5
    for (let k = 0; k < 30; k++) {
        const s = tr.step(k % 3 === 0 ? [blob(100 + 4 * k, 50)] : [], I);
        if (confirmedIds(s).length) ever = true;
    }
    ok('seen 2 of 5: never confirmed', !ever);
}
{
    const tr = createTracker();
    const seen = [1, 1, 0, 1, 1, 1, 1, 1];
    let s;
    const ids = [];
    seen.forEach((v, k) => { s = tr.step(v ? [blob(200 + 5 * k, 80 - 3 * k)] : [], I); ids.push(...s.filter(t => t.matched).map(t => t.id)); });
    ok('a one-frame gap keeps the id', new Set(ids).size === 1 && s[0].state === 'confirmed', ids);
}
{
    let ever = 0;
    for (const seed of [5, 6, 7, 8]) {
        const tr = createTracker();
        const r = mulberry32(seed);
        for (let k = 0; k < 300; k++) ever += confirmedIds(tr.step(Array.from({ length: 4 }, () => blob(r() * 640, r() * 360)), I)).length;
    }
    ok('random noise blobs (4 a frame, 4 × 300 frames on 640×360): nothing confirmed', ever === 0, ever);
}
{
    // a target with ±1 px measurement jitter, 6.7 px/frame
    const tr = createTracker();
    const r = mulberry32(1);
    let hit = 0;
    for (let k = 0; k < 100; k++) hit += confirmedIds(tr.step([blob(20 + 6 * k + (r() - 0.5) * 2, 30 + 3 * k + (r() - 0.5) * 2)], I)).length;
    ok('a jittery target stays confirmed (≥ 95 of 100 frames)', hit >= 95, hit);
}
{
    const tr = createTracker();
    let ever = 0;
    for (let k = 0; k < 20; k++) ever += confirmedIds(tr.step([blob(300 + (k % 2) * 0.5, 100)], I)).length;
    ok('a blob that stays put (edge flicker, parallax) never confirms', ever === 0, ever);
}
{
    // two targets crossing: A moves right, B moves left on the same row band
    const tr = createTracker();
    const byFrame = [];
    for (let k = 0; k < 20; k++) {
        const s = tr.step([blob(100 + 6 * k, 100 + 0.5 * k), blob(214 - 6 * k, 104 - 0.5 * k)], I);
        byFrame.push(s.filter(t => t.matched).map(t => [t.id, Math.sign(t.vx)]));
    }
    const ids = new Map();
    let consistent = true;
    for (const f of byFrame.slice(3)) for (const [id, dir] of f) { if (ids.has(id) && ids.get(id) !== dir) consistent = false; ids.set(id, dir); }
    ok('crossing targets keep their ids', consistent && ids.size === 2, [...ids]);
}
{
    // camera pans 7 px/frame to the right (scene moves left in the frame); the target moves
    // +3 px/frame in the world. H(t−1→t) shifts by −7.
    const tr = createTracker();
    const H = [1, 0, -7, 0, 1, 0, 0, 0, 1];
    let s;
    for (let k = 0; k < 8; k++) s = tr.step([blob(300 + (3 - 7) * k, 120)], k === 0 ? I : H);
    const t = s[0];
    ok('tracks carried through camera motion: velocity against the background', s.length === 1 && Math.abs(t.vx - 3) < 0.3 && t.state === 'confirmed', [t.vx, t.state]);
    // in the current frame the past positions lie 3 px apart (the target's own motion)
    ok('trail carried into the current frame', Math.abs(t.trail[t.trail.length - 1][0] - t.x) < 1e-9 && Math.abs(t.trail[0][0] - (t.x - 3 * (t.trail.length - 1))) < 1, t.trail.map(q => +q[0].toFixed(1)));
}
{
    const tr = createTracker({ maxSkip: 3 });
    for (let k = 0; k < 4; k++) tr.step([blob(100 + 5 * k, 50)], I);
    let s;
    for (let k = 0; k < 3; k++) s = tr.step([], null);
    ok('without camera motion tracks coast …', s.length === 1);
    s = tr.step([], null);
    ok('… and are dropped after maxSkip frames', s.length === 0);
}
{
    const tr = createTracker({ confirmN: 2, confirmM: 3 });
    const s = [0, 1].map(k => tr.step([blob(50 + 5 * k, 50)], I));
    ok('N and M are parameters (2 of 3)', confirmedIds(s[1]).length === 1);
}
{
    // dt: a skipped source frame doubles the expected motion
    const tr = createTracker();
    for (let k = 0; k < 4; k++) tr.step([blob(100 + 5 * k, 50)], I);
    const s = tr.step([blob(100 + 5 * 5, 50)], I, 2);
    ok('a skipped frame (dt = 2) still matches', s.filter(t => t.matched).length === 1 && s.length === 1, s.map(t => [t.id, t.matched]));
}
