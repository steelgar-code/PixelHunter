// The Benchmark tab: settings sets (presets, "current with one change"), a run on a hidden
// video (the player stays put), scores against labels, the check against tests/bench.mjs (a
// synthetic scene's truth as labels must give the same objects found and false tracks), the
// run saved and shown again, labelling unknown tracks from the table, Cancel.
import { launch, ok, openApp, showTab } from './lib/env.mjs';
import { sceneClip } from './lib/clips.mjs';

const dot = (size, contrast, fx, fy, vx, vy) => ({ size, contrast, fx, fy, vx, vy });
// scenario C of tests/bench.mjs (3×3 px, contrast 20, pan), seed 101
const C = { width: 640, height: 360, noise: 2, frames: 150, camera: 'pan', seed: 101, targets: [dot(3, 20, 120, 90, 6 + 3, 2.5 + 1), dot(3, -20, 150, 250, 6 + 3.5, 2.5 - 0.5)] };
// a shorter one through H.264, as a file
const D = { width: 640, height: 360, noise: 2, frames: 75, camera: 'handheld', seed: 7, targets: [dot(3, 40, 150, 120, 3 + 4, 1), dot(3, -40, 420, 240, 3 + 3.5, -1)] };

// in the page: labels made from per-frame truth ({ targets: [{ id, cx, cy, w, h }] }), all real, complete
async function truthLabels({ truth, fps }) {
    const by = new Map();
    truth.forEach((f, k) => { for (const t of f.targets) (by.get(t.id) || by.set(t.id, []).get(t.id)).push([k / fps, t.cx, t.cy, t.w, t.h]); });
    const now = new Date().toISOString();
    const set = { ...__ph.labels.set, complete: true, changed: now,
        objects: [...by].map(([id, keys]) => ({ id: `truth${id}`, label: 'real', source: 'tracked', size: [keys[0][3], keys[0][4]], keys, crops: [], created: now, changed: now })) };
    return __ph.labels.importFiles([new File([JSON.stringify(set)], 'truth.labels.json')]);
}

// in the page: what tests/bench.mjs measures for a scene and settings (its runInPage, reduced)
async function benchExpected({ options, params }) {
    const { createScene } = await import('/src/synth.js');
    const { createPipeline } = await import('/src/pipeline.js');
    const { matchFrame } = await import('/src/score.js');
    const s = createScene(options);
    const pipe = createPipeline(cv, { ...__ph.params, ...params, mode: 'everyFrame' });
    const firstConf = {}, seen = new Set(), tracks = {};
    let tf = 0, ctp = 0;
    for (let k = 0; k < s.frames; k++) {
        const f = s.frame(k);
        const rgba = new Uint8ClampedArray(f.grey.length * 4);
        for (let i = 0; i < f.grey.length; i++) { rgba[4 * i] = rgba[4 * i + 1] = rgba[4 * i + 2] = f.grey[i]; rgba[4 * i + 3] = 255; }
        const r = pipe.push({ imageData: new ImageData(rgba, s.width, s.height), width: s.width, height: s.height, time: k / s.fps, frame: k, seq: k, gap: 0, jump: k === 0, jumpReason: k === 0 ? 'start' : null, truth: f.truth }).result;
        if (!r) continue;
        const truth = r.truth.targets;
        for (const t of truth) seen.add(t.id);
        tf += truth.length;
        const m = matchFrame(r.confirmed.map(t => t.box), truth);
        ctp += m.tp;
        const matched = new Set(m.matches.map(x => x.detection));
        r.confirmed.forEach((t, i) => { const e = tracks[t.id] ??= { n: 0, hit: 0 }; e.n++; if (matched.has(i)) e.hit++; });
        for (const x of m.matches) firstConf[x.target] ??= r.frame;
    }
    pipe.dispose();
    return { targets: seen.size, found: Object.keys(firstConf).length, conf: ctp / tf, falseTracks: Object.values(tracks).filter(e => e.hit < e.n / 2).length };
}

const choose = (page, keys) => page.evaluate(ks => {
    for (const b of document.querySelectorAll('#benchSets input[type=checkbox]')) if (b.checked !== ks.includes(b.dataset.key)) b.click();
}, keys);
const runDone = page => page.waitForFunction(() => !__ph.bench.running && __ph.bench.result, null, { timeout: 240000 });

const browser = await launch();
try {
    const { page, errors } = await openApp(browser, { viewport: { width: 1440, height: 900 } });
    await showTab(page, 'bench');
    ok('Benchmark tab: presets, mine, current as sets; Run needs a video', (await page.locator('#benchSets input').count()) >= 5 && await page.isDisabled('#benchRun')
        && (await page.textContent('#benchProgressText')).includes('Open a video'));

    // --- synthetic scene C, its truth as labels, against bench.mjs ---
    await page.evaluate(o => __ph.openScene('Scenario C', o), C);
    await page.waitForFunction(() => __ph.labels.set && __ph.results.length >= 1, null, { timeout: 30000 });
    const truthC = await page.evaluate(async o => { const { createScene } = await import('/src/synth.js'); const s = createScene(o); return Array.from({ length: s.frames }, (_, k) => s.truth(k)); }, C);
    await page.evaluate(truthLabels, { truth: truthC, fps: 25 });
    ok('truth as labels: two real objects, clip complete', await page.evaluate(() => __ph.labels.set.objects.length === 2 && __ph.labels.set.complete));
    await choose(page, ['preset:mid']);
    const startTime = await page.evaluate(() => __ph.shown.time);
    await page.click('#benchRun');
    ok('a run shows progress and Cancel', await page.isVisible('#benchCancel'));
    await runDone(page);
    const exp = await page.evaluate(benchExpected, { options: C, params: {} });
    const [mid] = await page.evaluate(() => __ph.bench.scores());
    ok('validation (scenario C, Mid): the same objects found as bench.mjs', mid.found === exp.found && mid.labelled === exp.targets, { panel: mid, bench: exp });
    ok('… the same false tracks', mid.falseTracks === exp.falseTracks, { panel: mid.falseTracks, bench: exp.falseTracks });
    ok('… frame recall close to bench.mjs\'s confirmed recall (radius 4–4.5 px against 3 px)', Math.abs(mid.frameRecall - exp.conf) < 0.05, { panel: mid.frameRecall, bench: exp.conf });
    ok('… time per frame measured', mid.ms > 0 && mid.frames >= 145, mid);
    ok('the player stayed where it was', (await page.evaluate(() => __ph.shown.time)) === startTime);
    ok('the table: one row per set', (await page.locator('.bench-table tbody tr').count()) === 1 && (await page.textContent('.bench-table tbody tr')).includes('2 / 2'));

    // "Current with …": the value control follows the setting
    const control = () => page.evaluate(() => { const e = document.getElementById('benchChangeValue'); return { tag: e.tagName, type: e.type, min: e.min, max: e.max, options: e.options ? [...e.options].map(o => o.textContent) : null, value: e.value }; });
    await page.selectOption('#benchChangeKey', 'engine');
    let c = await control();
    // (0.13.0 added the choice Auto: three choices, the first one other than the current Main thread is preselected)
    ok('"Current with": Engine offers its choices in a list, another one than the current first', c.tag === 'SELECT' && c.options.join() === 'Auto,Main thread,Workers' && c.value !== 'main', c);
    await page.selectOption('#benchChangeKey', 'pathCheck');
    c = await control();
    ok('… an on / off setting: On / Off', c.tag === 'SELECT' && c.options.join() === 'On,Off' && c.value === 'false', c);
    await page.selectOption('#benchChangeKey', 'detectMode');
    c = await control();
    ok('… a choice setting: its labels', c.tag === 'SELECT' && c.options.some(o => /Robust/.test(o)), c);
    await page.selectOption('#benchChangeKey', 'minContrast');
    c = await control();
    ok('… a number: a number field in its range, at the current value', c.tag === 'INPUT' && c.type === 'number' && c.min === '1' && c.max === '30' && c.value === '4', c);
    await page.selectOption('#benchChangeKey', 'pathCheck');
    await page.click('#benchChangeForm button[type=submit]');
    ok('… a set named with the value as shown', (await page.textContent('#benchSets')).includes('Current · Confirm steady paths only: off') || /Current · .*: off/.test(await page.textContent('#benchSets')), await page.textContent('#benchSets'));
    await page.evaluate(() => { const x = [...document.querySelectorAll('#benchSets label')].find(l => /: off/.test(l.textContent)); if (x) x.querySelector('button.icon').click(); });

    // two sets, one of them "current with a change"
    // (min blob area 50 px: a 3×3 px target is never that large. It was min contrast 30 until
    // 0.12.0, whose smaller allowance for misalignment finds contrast 20 as often with it as without)
    await page.selectOption('#benchChangeKey', 'minArea');
    await page.fill('#benchChangeValue', '50');
    await page.click('#benchChangeForm button[type=submit]');
    ok('"Current with …" adds a set', await page.isChecked('#benchSets input[data-key="change:minArea=50"]'));
    await choose(page, ['preset:mid', 'change:minArea=50']);
    await page.click('#benchRun');
    await runDone(page);
    const two = await page.evaluate(() => __ph.bench.scores());
    ok('two sets in one run, scored apart (min blob area 50 px finds less of 3×3 px targets)', two.length === 2 && two[0].found === mid.found && two[0].frameRecall === mid.frameRecall && two[1].frameRecall < mid.frameRecall && /min blob area/i.test(two[1].name), two.map(x => [x.name, x.found, x.frameRecall]));
    ok('the run is saved with the clip', !!(await page.evaluate(() => __ph.labels.store.latestResult(__ph.labels.set.clip))));
    // opened again: the latest run is shown
    await page.evaluate(o => __ph.openScene('Scenario C', o), C);
    await page.waitForFunction(() => __ph.bench.result && __ph.bench.result.sets.length === 2, null, { timeout: 20000 });
    ok('opening the clip again shows its latest run', (await page.locator('.bench-table tbody tr').count()) === 2);

    // --- a file (hidden video), no labels: everything unknown, then labelled from the table ---
    const clip = await sceneClip(D);
    await page.setInputFiles('#file', clip.path);
    await page.waitForFunction(() => __ph.labels.set && __ph.results.length >= 1 && /scene-/.test(document.getElementById('srcLabel').textContent), null, { timeout: 30000 });
    await choose(page, ['current']);
    await page.click('#benchRun');
    await runDone(page);
    let [cur] = await page.evaluate(() => __ph.bench.scores());
    ok('a file runs on its own hidden video: every frame', cur.frames >= 70 && cur.frames <= 75, cur.frames);
    ok('no labels: its tracks are unknown', cur.labelled === 0 && cur.unknown >= 2 && cur.falseTracks === 0, cur);
    ok('… and a note says why', (await page.textContent('#benchResults')).includes('No labels for this clip'));
    await page.click('.bench-details li:first-child button:has-text("✓ Real")');
    [cur] = await page.evaluate(() => __ph.bench.scores());
    ok('✓ Real on a track: a label from its path, and the table scored again at once', cur.labelled === 1 && cur.found === 1 && cur.unknown >= 1
        && await page.evaluate(() => __ph.labels.set.objects.length === 1 && __ph.labels.set.objects[0].label === 'real'), cur);
    await page.click('.bench-details li:has(.unk) button:has-text("✗ Not")');
    [cur] = await page.evaluate(() => __ph.bench.scores());
    ok('✗ Not on a track: counted as a false track from now on', cur.falseTracks === 1, cur);
    const truthD = clip.truth;
    await page.evaluate(() => { __ph.labels.set.objects = []; });
    await page.evaluate(truthLabels, { truth: truthD, fps: 25 });
    [cur] = await page.evaluate(() => __ph.bench.scores());
    ok('the file against its truth: both objects found, no false tracks', cur.found === 2 && cur.labelled === 2 && cur.falseTracks === 0, cur);

    // Cancel
    await page.click('#benchRun');
    await page.waitForTimeout(500);
    await page.click('#benchCancel');
    await page.waitForFunction(() => !__ph.bench.running, null, { timeout: 20000 });
    ok('Cancel stops a run (the last run stays)', (await page.textContent('#benchProgressText')).includes('cancelled') && !!(await page.evaluate(() => __ph.bench.result)));

    // a browser that gives no frames from a hidden video: the run uses the player, the clip is opened again
    await page.evaluate(() => { __ph.bench.testHiddenFails = true; });
    await page.click('#benchRun');
    await page.waitForFunction(() => /uses the player/.test(document.getElementById('benchProgressText').textContent) || !__ph.bench.running, null, { timeout: 20000 });
    await page.waitForFunction(() => !__ph.bench.running && /opened again/.test(document.getElementById('benchProgressText').textContent), null, { timeout: 240000 });
    await page.waitForFunction(() => __ph.loop && document.getElementById('loading').hidden && !document.getElementById('play').disabled, null, { timeout: 30000 });
    [cur] = await page.evaluate(() => __ph.bench.scores());
    ok('no frames from a hidden video: the run uses the player, same result', cur.frames >= 70 && cur.found === 2 && cur.falseTracks === 0, cur);
    ok('… then the clip is open again, playable, labels kept', await page.evaluate(() => !!__ph.loop && __ph.labels.set && __ph.labels.set.objects.length === 2));
    await page.evaluate(() => { __ph.bench.testHiddenFails = false; });
    await showTab(page, 'stats');
    ok('Stats name the engine', (await page.textContent('#stEngine')) === 'Main thread', await page.textContent('#stEngine'));
    ok('no page errors', errors.length === 0, errors);
} finally {
    await browser.close();
}
