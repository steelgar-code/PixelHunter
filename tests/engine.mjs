// The Workers engine (src/workerPipeline.js, src/procWorker.js): the same candidates and objects
// as the main thread, on a synthetic scene and on a video file; switching engines while paused;
// stepping and going back; the debug views it has; a Benchmark run comparing both engines.
import { launch, ok, openApp, loadScene, showTab } from './lib/env.mjs';
import { sceneClip } from './lib/clips.mjs';

const dot = (size, contrast, fx, fy, vx, vy) => ({ size, contrast, fx, fy, vx, vy });
const D = { width: 960, height: 540, noise: 2, frames: 60, camera: 'handheld', seed: 9, shapes: 25, targets: [dot(3, 40, 200, 150, 3 + 4, 1), dot(3, -35, 600, 380, 3 + 3.5, -1)] };

// in the page: the results since `from` as { frame → candidates / confirmed }
const collect = from => Object.fromEntries(__ph.results.filter(r => r.frame >= from).map(r => [r.frame, {
    c: r.candidates.map(c => `${c[0].toFixed(2)},${c[1].toFixed(2)}`).sort().join(';'), n: r.confirmed.length }]));
const same = (a, b) => {
    const frames = Object.keys(a).filter(k => k in b);
    return { frames: frames.length, cand: frames.filter(k => a[k].c === b[k].c).length, conf: frames.filter(k => a[k].n === b[k].n).length };
};
const setEngine = async (page, e) => {
    await page.click(`label:has(input[name=param-engine][value=${e}])`);
    await page.waitForFunction(x => __ph.pipeline && (x === 'workers' ? __ph.pipeline.engine === 'workers' && __ph.pipeline.state === 'ready' : !__ph.pipeline.engine)
        && !document.getElementById('loading').checkVisibility?.() , e, { timeout: 30000 }).catch(() => {});
    await page.waitForFunction(() => !__ph.navigating, null, { timeout: 30000 });
};

const browser = await launch();
try {
    const { page, errors } = await openApp(browser, { hash: 'mode=everyFrame', viewport: { width: 1440, height: 900 } });
    page.on('console', m => { if (m.type() === 'error') console.log('console error:', m.text()); });
    await showTab(page, 'settings');
    ok('Engine setting: Main thread by default; worker count shown only with Workers', (await page.evaluate(() => __ph.params.engine)) === 'main'
        && await page.evaluate(() => document.getElementById('param-workers').closest('.param').classList.contains('inapplicable') || !!document.getElementById('param-workers').closest('.param').querySelector('.when-note')));

    // --- synthetic scene: main thread, then workers over the same frames ---
    await loadScene(page, 'pan-dots');
    await page.waitForFunction(() => __ph.results.length >= 1, null, { timeout: 30000 });
    for (let i = 0; i < 25; i++) await page.click('#step');
    await page.waitForTimeout(300);
    const main = await page.evaluate(collect, 0);
    await setEngine(page, 'workers');
    ok('switching to Workers: workers running, the frame shown processed again', await page.evaluate(() => __ph.pipeline.engine === 'workers' && __ph.pipeline.workers >= 1 && __ph.pipeline.state === 'ready'));
    await page.evaluate(() => { __ph.results.length = 0; });
    await loadScene(page, 'pan-dots');
    await page.waitForFunction(() => __ph.results.length >= 1, null, { timeout: 30000 });
    for (let i = 0; i < 25; i++) await page.click('#step');
    await page.waitForFunction(() => !__ph.navigating && __ph.shown && __ph.shown.frame >= 25, null, { timeout: 30000 });
    const work = await page.evaluate(collect, 0);
    const sc = same(main, work);
    ok('synthetic scene: the same candidates in every frame as the main thread', sc.frames >= 20 && sc.cand === sc.frames, sc);
    ok('… and the same number of confirmed objects', sc.conf === sc.frames, sc);
    ok('… objects listed', (await page.locator('#objectList li').count()) >= 2);
    const shown = await page.evaluate(() => __ph.shown.frame);
    await page.click('#back');
    await page.waitForFunction(f => !__ph.navigating && __ph.shown.frame === f - 1, shown, { timeout: 30000 });
    ok('‹ Back: one frame back, with its result', await page.evaluate(f => __ph.shown.frame === f - 1 && __ph.lastResult && __ph.lastResult.frame === f - 1, shown));
    await page.click('label:has(input[name=param-view][value=stabilised])');
    ok('Stabilised view works', (await page.evaluate(() => __ph.note)) === null);
    await page.click('label:has(input[name=param-view][value=mask])');
    ok('Mask view: says it is main-thread only', /Main thread/.test(await page.evaluate(() => __ph.note) || ''));
    await page.click('label:has(input[name=param-view][value=original])');

    // --- a video file played every frame ---
    const clip = await sceneClip(D);
    await page.setInputFiles('#file', clip.path);
    await page.waitForFunction(() => __ph.results.length >= 1 && /^scene-/.test(document.getElementById('srcLabel').textContent) && document.getElementById('loading').hidden, null, { timeout: 30000 });
    await page.evaluate(() => { __ph.results.length = 0; });
    await page.click('#play');
    await page.waitForFunction(() => !__ph.loop.playing && __ph.results.length >= 50, null, { timeout: 120000 });
    const fileW = await page.evaluate(collect, 0);
    const timings = await page.evaluate(() => __ph.results.slice(-20).map(r => r.timings.total));
    ok('a file played every frame with Workers: a result for every frame', Object.keys(fileW).length >= 55, Object.keys(fileW).length);
    await setEngine(page, 'main');
    await page.evaluate(() => { __ph.results.length = 0; __ph.loop.seek(0, 'test'); });
    await page.waitForTimeout(500);
    await page.click('#play');
    await page.waitForFunction(() => !__ph.loop.playing && __ph.results.length >= 50, null, { timeout: 120000 });
    const fileM = await page.evaluate(collect, 0);
    const sf = same(fileM, fileW);
    ok('… the same candidates as the main thread', sf.frames >= 50 && sf.cand === sf.frames, sf);
    ok('… times per frame recorded', timings.every(t => t > 0), timings);

    // --- the Benchmark: current settings on each engine ---
    await showTab(page, 'bench');
    await page.selectOption('#benchChangeKey', 'engine');
    await page.fill('#benchChangeValue', 'workers');
    await page.click('#benchChangeForm button[type=submit]');
    await page.evaluate(() => { for (const b of document.querySelectorAll('#benchSets input[type=checkbox]')) if (b.checked !== ['current', 'change:engine=workers'].includes(b.dataset.key)) b.click(); });
    await page.click('#benchRun');
    await page.waitForFunction(() => !__ph.bench.running && __ph.bench.result && __ph.bench.result.sets.length === 2, null, { timeout: 240000 });
    const [a, b] = await page.evaluate(() => __ph.bench.scores());
    ok('Benchmark: both engines find the same tracks', a.tracks === b.tracks && a.unknown === b.unknown && a.frames === b.frames, [a, b].map(x => ({ name: x.name, tracks: x.tracks, frames: x.frames, ms: x.ms })));
    ok('no page errors', errors.length === 0, errors);
} finally {
    await browser.close();
}
