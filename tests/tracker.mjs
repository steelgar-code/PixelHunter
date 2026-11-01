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
{
    // moves 10 frames, stops for 40 (not detected), moves on: same id, re-confirmed, not shown while held
    const tr = createTracker();
    const log = [];
    let x = 100;
    for (let k = 0; k < 70; k++) {
        const moving = k < 10 || k >= 50;
        if (moving) x += 4;
        log.push(tr.step(moving ? [blob(x, 60)] : [], I));
    }
    ok('a stopped track is held, not shown as a detection', log[30].length === 1 && log[30][0].state === 'held' && confirmedIds(log[30]).length === 0, log[30].map(t => t.state));
    ok('… picked up with the same id when it moves on, re-confirmed after N of M again', confirmedIds(log[50]).length === 0 && confirmedIds(log[52]).join() === '1' && confirmedIds(log[69]).join() === '1',
        [50, 51, 52].map(k => log[k].map(t => `${t.id}:${t.state}`)));
}
{
    const tr = createTracker({ holdFrames: 20 });
    let x = 100, s;
    for (let k = 0; k < 10; k++) s = tr.step([blob(x += 4, 60)], I);
    for (let k = 0; k < 20; k++) s = tr.step([], I);
    ok('held up to holdFrames …', s.length === 1 && s[0].state === 'held');
    s = tr.step([], I);
    ok('… then dropped', s.length === 0);
}
{
    // noise around where a track stopped: holding it adds no confirmations (vs holdFrames 0)
    const run = (hold, rate) => {
        let shown = 0;
        for (const seed of [9, 10, 11, 12, 13, 14, 15, 16]) {
            const tr = createTracker({ holdFrames: hold ? 50 : 0 });
            const r = mulberry32(seed);
            let x = 100;
            for (let k = 0; k < 10; k++) tr.step([blob(x += 4, 60)], I);
            for (let k = 0; k < 100; k++) shown += confirmedIds(tr.step(r() < rate ? [blob(x + (r() - 0.5) * 20, 60 + (r() - 0.5) * 20)] : [], I)).length;
        }
        return shown;
    };
    const res = [0.1, 0.15, 0.2].map(rate => [run(true, rate), run(false, rate)]);
    ok('holding a stopped track makes noise around it confirm no more than without holding', res.every(([a, b]) => a <= b), res);
}
{
    // holding doesn't let tracks steal each other: two movers, one stops while the other passes by
    const tr = createTracker();
    let ids = new Set();
    for (let k = 0; k < 40; k++) {
        const bs = [blob(100 + 5 * k, 100)];
        if (k < 10 || k > 30) bs.push(blob(300 + (k < 10 ? 3 * k : 30 + 3 * (k - 30)), 106));
        for (const t of tr.step(bs, I)) if (t.state === 'confirmed' && t.matched) ids.add(t.id);
    }
    ok('a mover passing a held track keeps its own id, the held one gets its id back', ids.size === 2, [...ids]);
}
{
    // dense noise (40 blobs a frame on 200×200 px): chained tracks confirm without the guards
    const run = opts => {
        let shown = 0;
        for (const seed of [21, 22, 23]) {
            const tr = createTracker(opts);
            const r = mulberry32(seed);
            for (let k = 0; k < 200; k++) shown += confirmedIds(tr.step(Array.from({ length: 40 }, () => blob(r() * 200, r() * 200)), I)).length;
        }
        return shown;
    };
    const off = run({ pathCheck: false, crowdGate: false }), path = run({ crowdGate: false }), crowd = run({ pathCheck: false }), both = run({});
    ok('dense noise: path check and crowd gate each cut chained false tracks, together at least by half', path < off && crowd < off && both <= Math.min(path, crowd) && both * 2 < off, { off, path, crowd, both });
}
{
    // a real target in that noise still confirms
    const tr = createTracker();
    const r = mulberry32(5);
    let hit = 0;
    for (let k = 0; k < 60; k++) {
        const s = tr.step([blob(20 + 3 * k, 100 + 0.5 * k), ...Array.from({ length: 40 }, () => blob(r() * 200, r() * 200))], I);
        if (s.some(t => t.state === 'confirmed' && t.matched && Math.abs(t.box.cx - (20 + 3 * k)) < 2)) hit++;
    }
    ok('… a steady target inside it still confirms and is followed (≥ 85 % of frames)', hit >= 51, hit);
}
{
    // back and forth (a swaying branch edge): confirms only without the path check
    const sway = opts => {
        const tr = createTracker({ minTravel: 2, ...opts });
        let shown = 0;
        for (let k = 0; k < 60; k++) shown += confirmedIds(tr.step([blob(100 + 4 * Math.sin(k * 1.3), 50 + 3 * Math.cos(k * 0.9))], I)).length;
        return shown;
    };
    ok('swaying back and forth: hardly shown with the path check (≤ a quarter of without)', sway({}) * 4 <= sway({ pathCheck: false }) && sway({ pathCheck: false }) > 0, [sway({}), sway({ pathCheck: false })]);
}
{
    // a frame without camera motion: paths cleared, nothing new starts or confirms
    const tr = createTracker();
    let s;
    for (let k = 0; k < 6; k++) s = tr.step([blob(100 + 4 * k, 50)], I);
    s = tr.step([blob(124, 50), blob(300, 200)], null);
    ok('no camera motion: paths cleared, no new track', s.length === 1 && s[0].trail.length <= 2, s.map(t => [t.id, t.trail.length]));
    const tr2 = createTracker({ motionPause: false });
    for (let k = 0; k < 6; k++) tr2.step([blob(100 + 4 * k, 50)], I);
    ok('… (without motionPause a new track starts there)', tr2.step([blob(124, 50), blob(300, 200)], null).length === 2);
}
{
    // pinned: kept watching through a stop far longer than holdFrames, same id when it moves on
    const tr = createTracker({ holdFrames: 20 });
    let x = 100, s;
    for (let k = 0; k < 10; k++) s = tr.step([blob(x += 4, 60)], I);
    tr.setPinned([s[0].id]);
    for (let k = 0; k < 300; k++) s = tr.step([], I);
    ok('pinned: still held after 300 frames without a sighting (holdFrames 20)', s.length === 1 && s[0].state === 'held' && s[0].pinned, s.map(t => [t.state, t.pinned]));
    let ids = new Set();
    for (let k = 0; k < 8; k++) for (const t of tr.step([blob(x += 4, 60)], I)) if (t.state === 'confirmed' && t.matched) ids.add(t.id);
    ok('… moving on there: the same id again', ids.size === 1 && ids.has(1), [...ids]);
}
{
    // pinned tracks survive frames without camera motion (the others are dropped after maxSkip)
    const tr = createTracker({ maxSkip: 3 });
    for (let k = 0; k < 6; k++) tr.step([blob(100 + 4 * k, 50), blob(300 + 4 * k, 150)], I);
    tr.setPinned([1]);
    let s;
    for (let k = 0; k < 10; k++) s = tr.step([], null);
    ok('pinned: kept through frames without camera motion, the others dropped', s.length === 1 && s[0].id === 1, s.map(t => t.id));
}
{
    // carried with the scene: the camera pans away (the scene moves 10 px/frame) and back
    const tr = createTracker();
    let s;
    for (let k = 0; k < 6; k++) s = tr.step([blob(100 + 4 * k, 50)], I);
    tr.setPinned([1]);
    const away = [1, 0, -10, 0, 1, 0, 0, 0, 1], back = [1, 0, 10, 0, 1, 0, 0, 0, 1];
    for (let k = 0; k < 30; k++) s = tr.step([], away);
    ok('pinned: waits where it was, moving with the scene (out of view at −176 px)', Math.abs(s[0].lastSeen[0] - (120 - 300)) < 1e-6, s[0].lastSeen);
    for (let k = 0; k < 30; k++) s = tr.step([], back);
    ok('… and back in view where it was', Math.abs(s[0].lastSeen[0] - 120) < 1e-6 && s[0].id === 1, s[0].lastSeen);
}
{
    // predictions for the background-shift check: confirmed tracks seen recently, carried by H
    const tr = createTracker();
    for (let k = 0; k < 5; k++) tr.step([blob(100 + 4 * k, 50 + 2 * k), blob(400, 300 + 7 * (k % 2))], I);
    const pr = tr.predict([1, 0, 10, 0, 1, -5, 0, 0, 1]);
    ok('predict: only confirmed tracks, carried by H and moved on by their velocity', pr.length === 1 && Math.abs(pr[0].x - (116 + 4 + 10)) < 0.3 && Math.abs(pr[0].y - (58 + 2 - 5)) < 0.3, pr);
    ok('… with their velocity and gate', Math.abs(pr[0].vx - 4) < 0.2 && pr[0].gate > 0, pr[0]);
    ok('… nothing without camera motion', tr.predict(null).length === 0);
}
{
    // confirmation by evidence: age (s) and summed strength
    const ev = { confirmBy: 'evidence', minAge: 0.4, minEvidence: 6 };
    const run = (strength, frames = 30, fps = 25) => {
        const tr = createTracker(ev);
        let at = null, early = null;
        for (let k = 0; k < frames; k++) {
            const s = tr.step([{ ...blob(100 + 4 * k, 50 + 2 * k), strength }], I, 1, { time: k / fps, frame: k });
            const c = s.find(t => t.state === 'confirmed' && t.matched);
            if (c && at === null) { at = k; early = c.early; }
        }
        return { at, early };
    };
    const strong = run(3), plain = run(1), faint = run(0.5);
    ok('evidence: a strong object confirms as soon as it is old enough (0.4 s = frame 10)', strong.at === 10, strong.at);
    ok('… one at the threshold once the evidence adds up (6 sightings, but not before 0.4 s)', plain.at === 10, plain.at);
    ok('… a faint one later (12 sightings at 0.5)', faint.at === 11, faint.at);
    ok('… its earlier sightings are handed out with the confirmation, in order', strong.early.length === 10 && strong.early[0].frame === 0 && strong.early[9].frame === 9 && strong.early[0].time === 0, strong.early.map(e => e.frame));
    const tr = createTracker({ ...ev, minAge: 0 });
    let n = 0;
    for (let k = 0; k < 12; k++) n += tr.step([{ ...blob(100 + 4 * k, 50), strength: 10 }], I, 1, { time: k / 25, frame: k }).filter(t => t.state === 'confirmed' && t.matched).length;
    ok('… one sighting counts at most 3 (a single bright blip never confirms alone)', n === 12 - 2, n);
    // a track still building up is dropped after more than maxGap missed frames
    const tg = createTracker({ ...ev, maxGap: 2 });
    const ids = new Set();
    [1, 1, 1, 0, 0, 0, 1, 1].forEach((v, k) => { for (const t of tg.step(v ? [{ ...blob(100 + 4 * k, 50), strength: 1 }] : [], I, 1, { time: k / 25, frame: k })) ids.add(t.id); });
    ok('… a building track missed 3 frames (maxGap 2) is dropped: a new id after', ids.size === 2, [...ids]);
    // random noise: nothing confirms with evidence either
    let ever = 0;
    for (const seed of [5, 6, 7, 8]) {
        const tn = createTracker(ev);
        const r = mulberry32(seed);
        for (let k = 0; k < 300; k++) ever += tn.step(Array.from({ length: 4 }, () => ({ ...blob(r() * 640, r() * 360), strength: 1.5 })), I, 1, { time: k / 25, frame: k })
            .filter(t => t.state === 'confirmed' && t.matched).length;
    }
    ok('evidence: random noise blobs never confirm', ever === 0, ever);
}
{
    // N of M hands out the earlier sightings too, and a progress for tracks building up
    const tr = createTracker();
    let s;
    const prog = [];
    for (let k = 0; k < 3; k++) { s = tr.step([blob(100 + 4 * k, 50)], I, 1, { time: k / 25, frame: k }); prog.push(+s[0].progress.toFixed(2)); }
    ok('N of M: progress 1/3, 2/3, then confirmed', prog.join() === '0.33,0.67,1', prog);
    ok('… the first two sightings handed out on confirming', s[0].early && s[0].early.map(e => e.frame).join() === '0,1', s[0].early);
    s = tr.step([blob(112, 50)], I, 1, { time: 3 / 25, frame: 3 });
    ok('… once only', !s[0].early);
}
{
    // a spot fixed on the screen while the camera pans 2 px/frame: against the background it
    // moves steadily, but it never confirms (unless the check is off: a camera following its target)
    const pan = [1, 0, -2, 0, 1, 0, 0, 0, 1];
    const run = opts => {
        const tr = createTracker(opts);
        let n = 0;
        for (let k = 0; k < 20; k++) n += confirmedIds(tr.step([blob(200 + (k % 2) * 0.4, 120)], pan)).length;
        return n;
    };
    ok('a spot fixed on the screen (camera panning) never confirms', run({}) === 0, run({}));
    ok('… unless the screen-fixed check is off', run({ screenFixed: false }) > 10, run({ screenFixed: false }));
    // a real object moving on the screen with the same pan confirms
    const tr = createTracker();
    let n = 0;
    for (let k = 0; k < 10; k++) n += confirmedIds(tr.step([blob(200 + 3 * k, 120)], pan)).length;
    ok('… an object moving on the screen still confirms', n >= 7, n);
}
