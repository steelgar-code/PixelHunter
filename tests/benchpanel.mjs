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

    // two sets, one of them "current with a change"
    await page.selectOption('#benchChangeKey', 'minContrast');
    await page.fill('#benchChangeValue', '30');
    await page.click('#benchChangeForm button[type=submit]');
    ok('"Current with …" adds a set', await page.isChecked('#benchSets input[data-key="change:minContrast=30"]'));
    await choose(page, ['preset:mid', 'change:minContrast=30']);
    await page.click('#benchRun');
    await runDone(page);
    const two = await page.evaluate(() => __ph.bench.scores());
    ok('two sets in one run, scored apart (min contrast 30 finds less at contrast 20)', two.length === 2 && two[0].found === mid.found && two[0].frameRecall === mid.frameRecall && two[1].frameRecall < mid.frameRecall && two[1].name.includes('min contrast'), two.map(x => [x.name, x.found, x.frameRecall]));
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
    ok('no page errors', errors.length === 0, errors);
} finally {
    await browser.close();
}
