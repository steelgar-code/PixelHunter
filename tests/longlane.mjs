// The long comparison (src/longLane.js) and what shows a slow or long track: blocks and their
// plan, a block dropped when a fit is missing, very slow objects found on a tripod that the other
// lanes miss, the lane resting on a panning camera, off = nothing of it runs, no Mats left, the
// pictures from the lane's own frames, the lane named in the object list, inspector and exports, the
// box kept clear of a small object, and the Stats row. (Both engines alike: engine.mjs.)
import { launch, ok, openApp, showTab } from './lib/env.mjs';
import { instrumentMats } from './lib/mats.mjs';
import { blockPlan, createLongLane, LONG_RING } from '../src/longLane.js';
import { objectsCsv, LANE_NAMES } from '../src/objects.js';
import { createExportLog } from '../src/exportLog.js';

// --- pure parts ---
{
    ok('blocks: 2 s at 25 fps = 12 blocks of 4 frames; 4 s = 12 of 8; 0.5 s = 3 of 4; 4 s at 60 fps = 12 of 20',
        JSON.stringify([blockPlan(2, 25), blockPlan(4, 25), blockPlan(0.5, 25), blockPlan(4, 60)]) === JSON.stringify([{ B: 4, mMax: 12 }, { B: 8, mMax: 12 }, { B: 4, mMax: 3 }, { B: 20, mMax: 12 }]));
    const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    const fit = { ok: true, Hfull: [1, 0, 0.1, 0, 1, 0, 0, 0, 1], H: [1, 0, 0.05, 0, 1, 0, 0, 0, 1], misfit: 0.02 };
    const geom = { w: 320, h: 180, kx: 2 };
    const lane = createLongLane({ long: true, longSecs: 2, slowBudget: 6, track: {} });
    const ops = [];
    for (let k = 0; k < 14; k++) ops.push(lane.addFrame({ e: k ? fit : null, meta: { time: k / 25, frame: k }, frames: 1, geom }).map(o => o.op).join('+') || '-');
    // the frame rate is known after 6 frames; blocks from then on: start, add, add, add + close
    ok('blocks built from the sixth frame on (the frame rate known): start, add, add, add and close (4 frames each)', ops.join(' ') === '- - - - - start add add add+close start add add add+close start', ops.join(' '));
    const lane2 = createLongLane({ long: true, longSecs: 2, slowBudget: 6, track: {} });
    const o2 = [];
    for (let k = 0; k < 12; k++) o2.push(lane2.addFrame({ e: k === 8 ? { ok: false, reason: 'test' } : k ? fit : null, meta: { time: k / 25, frame: k }, frames: 1, geom }).map(o => o.op).join('+') || '-');
    ok('a fit missing inside a block: the block is dropped and a new one starts there', o2.join(' ') === '- - - - - start add add start add add add+close', o2.join(' '));
    const moving = createLongLane({ long: true, longSecs: 2, slowBudget: 6, track: {} });
    const pan = { ...fit, Hfull: [1, 0, 4, 0, 1, 0, 0, 0, 1] };
    const o3 = [];
    for (let k = 0; k < 12; k++) o3.push(moving.addFrame({ e: k ? pan : null, meta: { time: k / 25, frame: k }, frames: 1, geom }).map(o => o.op).join('+') || '-');
    ok('the picture moving more than the budget within a block (4 px a frame): no block closes', !o3.some(x => x.includes('close')), o3.join(' '));
    const off = createLongLane({ long: false, track: {} });
    ok('off: no work asked for', off.addFrame({ e: fit, meta: { time: 0, frame: 0 }, frames: 1, geom }).length === 0 && off.plan({ geom }).rest === 'off');
    ok('the ring holds 25 blocks', LONG_RING === 25 && I.length === 9);
    // the lane named in the exports
    const csv = objectsCsv([{ id: 1, label: null, first: { frame: 1, time: 0.04 }, confirmedAt: { frame: 9, time: 0.36 }, last: { frame: 9, time: 0.36 }, frames: 1, w: 2, h: 2, contrast: 20, speed: 0.05, lane: 'long' }]);
    ok('objects CSV: a "found_by" column naming the comparison', /,found_by$/.test(csv.split('\n')[0]) && csv.split('\n')[1].endsWith(`,${LANE_NAMES.long}`), csv);
    const log = createExportLog();
    log.add({ frame: 9, time: 0.36, scale: 1, confirmed: [{ id: 2000001, lane: 'long', box: { x: 9, y: 9, w: 2, h: 2, cx: 10, cy: 10, area: 4 }, vx: 0.05, vy: 0 },
        { id: 5, box: { x: 9, y: 19, w: 2, h: 2, cx: 10, cy: 20, area: 4 }, vx: 3, vy: 0 }] });
    const det = log.toJSON({}).detections;
    ok('detections JSON: lane "long" on the long comparison\'s rows, nothing added to the others', det.find(d => d.trackId === 2000001).lane === 'long' && !('lane' in det.find(d => d.trackId === 5)), det);
}

const own = (size, contrast, fx, fy, vx, vy) => ({ size, contrast, fx, fy, vx, vy });
// two objects too slow for the slow lane (0.1 px a frame: 1.2 px over its ±12 frames)
const tripod = { width: 320, height: 180, noise: 2, frames: 240, fps: 25, camera: 'tripod', seed: 41,
    targets: [own(3, 25, 80, 60, 0.1, 0.03), own(3, -25, 230, 120, -0.1, -0.03)] };
const browser = await launch();
try {
    const { page, errors } = await openApp(browser);
    await page.evaluate(instrumentMats);
    await page.evaluate(async () => {
        const { createScene, greyToRgba } = await import('/src/synth.js');
        const { createPipeline } = await import('/src/pipeline.js');
        window.runLong = (sceneOpts, params = {}, from = 0) => {
            const s = createScene(sceneOpts);
            const pipe = createPipeline(cv, { ...window.__ph.params, mode: 'everyFrame', ...params });
            let tf = 0, hit = 0, falseBoxes = 0, longMarked = 0, passes = 0, ring = null, crop = null, sigs = [];
            const states = {}, ids = new Set(), ms = new Set();
            for (let k = 0; k < s.frames; k++) {
                const f = s.frame(k);
                const r = pipe.push({ imageData: new ImageData(greyToRgba(f.grey), s.width, s.height), width: s.width, height: s.height,
                    time: k / s.fps, frame: k, seq: k, gap: 0, jump: k === 0, truth: f.truth }).result;
                ring = pipe.geometry.ring;
                if (!r) continue;
                sigs.push(`${r.frame}:${r.candidates.length}:${r.confirmed.map(t => `${t.id}@${t.box.cx.toFixed(2)},${t.box.cy.toFixed(2)}`).join(';')}`);
                if (r.long) { states[r.long.state] = (states[r.long.state] || 0) + 1; if (r.long.state === 'pass') { passes++; ms.add(r.long.m); } }
                for (const c of r.confirmed) if (c.lane === 'long' && !crop) {
                    const q = pipe.laneCrop(c.id);
                    if (q) {
                        // red (the earlier block) and blue (the later one) differ from green (block u) somewhere near the middle
                        let fringe = 0;
                        for (let i = 0; i < q.rgba.length; i += 4) fringe = Math.max(fringe, Math.abs(q.rgba[i] - q.rgba[i + 1]), Math.abs(q.rgba[i + 2] - q.rgba[i + 1]));
                        crop = { side: q.side, fringe, viaCrop: pipe.crop(c.box.cx, c.box.cy, undefined, c) === q.rgba };
                    }
                }
                if (r.frame < from) continue;
                for (const t of r.truth.targets) { tf++; if (r.confirmed.some(c => Math.hypot(c.box.cx - t.cx, c.box.cy - t.cy) <= 3)) hit++; }
                for (const c of r.confirmed) {
                    if (c.lane === 'long') { longMarked++; ids.add(c.id); }
                    if (!r.truth.targets.some(t => Math.hypot(c.box.cx - t.cx, c.box.cy - t.cy) <= 6)) falseBoxes++;
                }
            }
            pipe.dispose();
            return { recall: tf ? hit / tf : null, falseBoxes, longMarked, ids: [...ids], passes, ms: [...ms], states, ring, crop, sig: sigs.join('|') };
        };
    });

    const base = await page.evaluate(([o]) => runLong(o, {}, 150), [tripod]);
    const off = await page.evaluate(([o]) => runLong(o, { long: false }, 150), [tripod]);
    ok('off by default: the same results as with the setting off, no long stats, the frame ring unchanged (25 with the slow lane)', base.sig === off.sig
        && Object.keys(off.states).length === 0 && off.ring === 25 && off.recall < 0.2, { recall: off.recall, ring: off.ring });
    ok('… and no preset sets it', await page.evaluate(async () => { const { PRESETS } = await import('/src/params.js'); return Object.values(PRESETS).every(p => !('long' in p.values) && !('longSecs' in p.values)); }));
    const on = await page.evaluate(([o]) => runLong(o, { long: true }, 150), [tripod]);
    ok('on, tripod: objects at 0.1 px a frame confirmed from frame 150 on', on.recall >= 0.8, { recall: on.recall, passes: on.passes, ms: on.ms });
    ok('… with comparisons of up to 12 blocks, the frame ring unchanged', on.ms.includes(12) && on.ring === 25, { ms: on.ms, ring: on.ring });
    ok('… marked as the long comparison\'s, ids from 2 000 000, no confirmed box away from an object', on.longMarked > 0 && on.ids.every(id => id >= 2000000) && on.falseBoxes === 0, { ids: on.ids, falseBoxes: on.falseBoxes });
    ok('… its picture cut from the blocks compared: red and blue fringes show the movement; crop() of the track gives the same', on.crop && on.crop.side === 32 && on.crop.fringe >= 10 && on.crop.viaCrop, on.crop);
    const pan = await page.evaluate(([o]) => runLong({ ...o, camera: 'pan', frames: 80 }, { long: true }), [tripod]);
    ok('panning camera: the long comparison rests', pan.passes === 0 && (pan.states.resting || 0) > 20, pan.states);
    ok('no Mats left behind', (await page.evaluate(() => window.__liveMats())) === 0, await page.evaluate(() => window.__liveMats()));

    // a confirmed box drawn around a 2 px object leaves the object itself uncovered, however far zoomed
    const covered = await page.evaluate(async () => {
        const { drawTracks } = await import('/src/overlay.js');
        const out = [];
        for (const zoom of [1, 4, 8]) {
            const c = new OffscreenCanvas(200, 200), ctx = c.getContext('2d');
            const tf = { dpr: 1, x: v => 100 + (v - 50) * zoom, y: v => 100 + (v - 50) * zoom };
            drawTracks(ctx, tf, [{ id: 1, trail: [], box: { x: 49.5, y: 49.5, w: 2, h: 2, cx: 50.5, cy: 50.5 } }]);
            // the object's own pixels on the screen
            const x0 = Math.floor(tf.x(49)), x1 = Math.ceil(tf.x(51));
            const d = ctx.getImageData(x0, x0, x1 - x0, x1 - x0).data;
            let n = 0;
            for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
            out.push(n);
        }
        return out;
    });
    ok('the box around a 2 px object never covers it (zoom 1, 4, 8)', covered.every(n => n === 0), covered);

    // in the app: the Stats row, the object list and the inspector
    const { page: p2, errors: e2 } = await openApp(browser, { hash: 'mode=everyFrame&long=true' });
    await showTab(p2, 'stats');
    await p2.evaluate(o => __ph.openScene('slow-test', o), { ...tripod, frames: 230 });
    await p2.waitForFunction(() => __ph.results.length >= 1, null, { timeout: 30000 });
    await p2.click('#play');
    await p2.waitForFunction(() => !__ph.loop.playing && __ph.results.length >= 200, null, { timeout: 180000 });
    await p2.waitForTimeout(300);
    const row = await p2.textContent('#stLong');
    ok('Stats: the long comparison\'s row says what it compares and how slow an object it can find', await p2.isVisible('#stLong')
        && /±\d+ blocks of 4 frames \(±[\d.]+ s\), every \d+ frames · .*slowest found ≈ 0\.0\d px a frame/.test(row), row);
    await showTab(p2, 'objects');
    await p2.waitForTimeout(300);
    const list = await p2.textContent('#objectList');
    ok('object list: the object named as found by the long comparison, its contrast a number', /long comparison/.test(list) && !/NaN/.test(list), list.slice(0, 300));
    await p2.click('#objectList li:first-child');
    await p2.waitForTimeout(200);
    ok('inspector: "Found by"', /Found by\s*long comparison/.test(await p2.textContent('#inspData')), await p2.textContent('#inspData'));
    ok('no page errors', errors.length === 0 && e2.length === 0, [...errors, ...e2]);
} finally {
    await browser.close();
}
