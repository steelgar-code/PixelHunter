// The slow lane (src/slowLane.js): how long a comparison the camera allows, how often, the
// screen-fixed guard on a still camera, slow objects found on a tripod and none on swaying trees
// at the lane's end of things, the lane resting while the camera pans, its tracks marked, the
// ring size, no Mats left behind, and the Stats row. (Both engines alike: engine.mjs.)
import { launch, ok, openApp, loadScene, showTab } from './lib/env.mjs';
import { instrumentMats } from './lib/mats.mjs';
import { chooseN, cadenceOf, ringFrames, slowMaxOf, ragged } from '../src/slowLane.js';
import { createTracker } from '../src/tracker.js';

// --- pure parts ---
{
    ok('cadence: a pass every max(2, ⌈n / 3⌉) frames', [2, 3, 6, 7, 12].map(cadenceOf).join() === '2,2,2,3,4');
    ok('ring: 2s + 1 with the lane off, 2 · slowMax + 1 with it on', ringFrames(1, {}) === 3 && ringFrames(2, { slow: false, slowMax: 12 }) === 5
        && ringFrames(1, { slow: true, slowMax: 12 }) === 25 && ringFrames(1, { slow: true, slowMax: 6 }) === 13 && ringFrames(12, { slow: true, slowMax: 4 }) === 25);
    ok('slowMax kept within 2–12', slowMaxOf({ slowMax: 40 }) === 12 && slowMaxOf({ slowMax: 1 }) === 2 && slowMaxOf({}) === 12);
    // fits: slot b holds H(frame b+1 → frame b); a camera drifting dx px a frame
    const ring = (n, dx, missing = -1) => b => ({ egoIn: b < n && b !== missing ? { ok: true, Hfull: [1, 0, dx, 0, 1, 0, 0, 0, 1], H: [1, 0, dx / 2, 0, 1, 0, 0, 0, 1] } : null });
    const geom = { w: 640, h: 360 };
    ok('still camera: the longest comparison', chooseN({ at: ring(25, 0), count: 25, s: 1, max: 12, budget: 6, ...geom, lastBack: null }).n === 12);
    ok('drifting 1 px a frame, budget 6: n = 6 (the picture moves n px from u to either end)', chooseN({ at: ring(25, 1), count: 25, s: 1, max: 12, budget: 6, ...geom, lastBack: null }).n === 6);
    const fast = chooseN({ at: ring(25, 4), count: 25, s: 1, max: 12, budget: 6, ...geom, lastBack: null });
    ok('panning 4 px a frame: no pass (n would be 1 = the stride), "camera moving"', !fast.n && fast.reason === 'camera moving', fast);
    ok('not yet 2n + 1 frames: a shorter one', chooseN({ at: ring(25, 0), count: 13, s: 1, max: 12, budget: 6, ...geom, lastBack: null }).n === 6);
    ok('a fit missing in the span: only spans without it', chooseN({ at: ring(25, 0, 9), count: 25, s: 1, max: 12, budget: 6, ...geom, lastBack: null }).n === 4);
    ok('u never goes back: n below the last pass\'s u', chooseN({ at: ring(25, 0), count: 25, s: 1, max: 12, budget: 6, ...geom, lastBack: 10 }).n === 9);
    // what the ragged-candidate rule removes (a moved branch rim) and, as its stated limit, a thin diagonal object
    ok('ragged rule: a tree rim (17×29 px, 91 set) dropped; a 12×12 or 20×20 object, a 3×8 person, an L of person and shadow (6×10, 36 set) kept',
        ragged({ w: 17, h: 29, area: 91 }) && !ragged({ w: 12, h: 12, area: 144 }) && !ragged({ w: 20, h: 20, area: 380 }) && !ragged({ w: 3, h: 8, area: 24 }) && !ragged({ w: 6, h: 10, area: 36 }));
    ok('… its limit: a thin object across its box (2 × 14 px at 45°: 15×15, 28 set) is dropped too (said in the help text)', ragged({ w: 15, h: 15, area: 28 }));
    ok('stride not below slowMax: no pass', !chooseN({ at: ring(25, 0), count: 25, s: 4, max: 4, budget: 6, ...geom, lastBack: null }).n);
}

// --- the screen-fixed guard asks whether the background moved (fixedMinMove) ---
{
    const blob = (x, y) => ({ cx: x, cy: y, x: x - 1, y: y - 1, w: 3, h: 3, area: 9 });
    const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    const run = (opts, H, step) => {
        const tr = createTracker(opts);
        let n = 0;
        for (let k = 0; k < 30; k++) n += tr.step([blob(200 + step(k), 120)], H).filter(t => t.state === 'confirmed' && t.matched).length;
        return n;
    };
    // an object at 0.2 px a step on a still camera stays within 1.5 px for 8 sightings
    ok('a slow object on a still camera: dropped by the old guard', run({}, I, k => 0.2 * k) === 0, run({}, I, k => 0.2 * k));
    ok('… confirmed when the guard asks for background motion (fixedMinMove 3)', run({ fixedMinMove: 3 }, I, k => 0.2 * k) >= 10, run({ fixedMinMove: 3 }, I, k => 0.2 * k));
    const pan = [1, 0, -2, 0, 1, 0, 0, 0, 1];
    ok('… a spot fixed on the screen while the camera pans still never confirms', run({ fixedMinMove: 3 }, pan, k => (k % 2) * 0.4) === 0);
}

const own = (size, contrast, fx, fy, vx, vy) => ({ size, contrast, fx, fy, vx, vy });
const browser = await launch();
try {
    const { page, errors } = await openApp(browser);
    await page.evaluate(instrumentMats);
    await page.evaluate(async () => {
        const { createScene, greyToRgba } = await import('/src/synth.js');
        const { createPipeline } = await import('/src/pipeline.js');
        window.runSlow = (sceneOpts, params = {}, from = 0) => {
            const s = createScene(sceneOpts);
            const pipe = createPipeline(cv, { ...window.__ph.params, mode: 'everyFrame', ...params });
            let tf = 0, hit = 0, falseBoxes = 0, slowMarked = 0, passes = 0, ring = null, sigs = [];
            const states = {}, ids = new Set(), ns = new Set();
            for (let k = 0; k < s.frames; k++) {
                const f = s.frame(k);
                const r = pipe.push({ imageData: new ImageData(greyToRgba(f.grey), s.width, s.height), width: s.width, height: s.height,
                    time: k / s.fps, frame: k, seq: k, gap: 0, jump: k === 0, truth: f.truth }).result;
                ring = pipe.geometry.ring;
                if (!r) continue;
                sigs.push(`${r.frame}:${r.candidates.length}:${r.confirmed.map(t => `${t.id}@${t.box.cx.toFixed(2)},${t.box.cy.toFixed(2)}`).join(';')}`);
                if (r.slow) { states[r.slow.state] = (states[r.slow.state] || 0) + 1; if (r.slow.state === 'pass') { passes++; ns.add(r.slow.n); } }
                if (r.frame < from) continue;
                for (const t of r.truth.targets) { tf++; if (r.confirmed.some(c => Math.hypot(c.box.cx - t.cx, c.box.cy - t.cy) <= 3)) hit++; }
                for (const c of r.confirmed) {
                    if (c.lane === 'slow') { slowMarked++; ids.add(c.id); }
                    if (!r.truth.targets.some(t => Math.hypot(c.box.cx - t.cx, c.box.cy - t.cy) <= 3)) falseBoxes++;
                }
            }
            pipe.dispose();
            return { recall: tf ? hit / tf : null, falseBoxes, slowMarked, ids: [...ids], passes, ns: [...ns], states, ring, sig: sigs.join('|') };
        };
    });
    const tripod = { width: 320, height: 180, noise: 2, frames: 110, fps: 25, camera: 'tripod', seed: 31,
        targets: [own(3, 25, 80, 60, 0.3, 0.1), own(3, -25, 240, 120, -0.4, -0.1)] };

    const off = await page.evaluate(([o]) => runSlow(o, { slow: false }, 60), [tripod]);
    ok('lane off: slow objects not found (as before), ring of 3 frames, no slow stats', off.recall === 0 && off.ring === 3 && Object.keys(off.states).length === 0, { recall: off.recall, ring: off.ring });
    const off2 = await page.evaluate(([o]) => runSlow(o, {}, 60), [tripod]);
    ok('… the same results as without the setting at all', off2.sig === off.sig);
    const on = await page.evaluate(([o]) => runSlow(o, { slow: true }, 60), [tripod]);
    ok('lane on, tripod: slow objects (0.3, 0.4 px a frame) confirmed from frame 60 on', on.recall >= 0.8, { recall: on.recall, passes: on.passes, ns: on.ns });
    // (while the history fills, shorter comparisons every 2 frames: n = 2 … 10, then 12 every 4)
    ok('… with the longest comparison, a pass every 4 frames once the history is full', on.ns.includes(12) && on.passes >= 24 && on.passes <= 34, { passes: on.passes, ns: on.ns });
    ok('… marked as the slow lane\'s, ids from their own range, no other confirmed boxes', on.slowMarked > 0 && on.ids.every(id => id >= 1000000) && on.falseBoxes === 0, { ids: on.ids, falseBoxes: on.falseBoxes });
    ok('… ring of 25 frames', on.ring === 25);
    const pan = await page.evaluate(([o]) => runSlow({ ...o, camera: 'pan', frames: 60 }, { slow: true }), [tripod]);
    ok('panning camera: the lane rests (camera moving)', pan.passes === 0 && pan.states.resting > 20, pan.states);
    const trees = { width: 320, height: 180, noise: 2, frames: 150, fps: 25, camera: 'tripod', seed: 33, targets: [],
        trees: [{ fx: 90, fy: 60, r: 25, parallax: 0.1, sway: 2.5, swayPeriod: 29 }, { fx: 230, fy: 120, r: 20, parallax: 0.1, sway: 3, swayPeriod: 23 }] };
    const tr = await page.evaluate(([o]) => runSlow(o, { slow: true }), [trees]);
    // (the fast lane's own false boxes along the frame's edge on a tripod are not the lane's: detect.js edgeMargin)
    ok('trees swaying on a tripod: no confirmed slow tracks', tr.slowMarked === 0 && tr.passes > 30, { slowMarked: tr.slowMarked, passes: tr.passes });
    ok('no Mats left behind', (await page.evaluate(() => window.__liveMats())) === 0, await page.evaluate(() => window.__liveMats()));

    // the Stats row, with the setting from the URL
    const { page: p2, errors: e2 } = await openApp(browser, { hash: 'mode=everyFrame&slow=true' });
    await showTab(p2, 'stats');
    await loadScene(p2, 'pan-dots');
    await p2.waitForFunction(() => __ph.results.length >= 1, null, { timeout: 30000 });
    for (let i = 0; i < 6; i++) await p2.click('#step');
    await p2.waitForFunction(() => !__ph.navigating && __ph.shown && __ph.shown.frame >= 5, null, { timeout: 30000 });
    await p2.waitForTimeout(300);
    const row = await p2.textContent('#stSlow');
    ok('Stats: the slow lane\'s row says why it rests on a panning camera', /^resting: camera moving/.test(row) && await p2.isVisible('#stSlow'), row);
    ok('no page errors', errors.length === 0 && e2.length === 0, [...errors, ...e2]);
} finally {
    await browser.close();
}
