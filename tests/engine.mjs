// The Workers engine (src/workerPipeline.js, src/procWorker.js): the same candidates and objects
// as the main thread, on a synthetic scene and on a video file; switching engines while paused;
// stepping and going back; the debug views (Stabilised, Raw diff, Mask); a Benchmark run
// comparing both engines; the slow lane (its candidates pass by pass, its tracks, no Mats left).
import { launch, ok, openApp, loadScene, showTab } from './lib/env.mjs';
import { sceneClip } from './lib/clips.mjs';
import { instrumentMats } from './lib/mats.mjs';

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
    await page.waitForTimeout(300);
    ok('Stats name the engine and its workers', /^Workers · \d+ detection \+ 1 camera motion$/.test(await page.textContent('#stEngine')), await page.textContent('#stEngine'));
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
    ok('Mask view: from the next frame processed', /next frame/.test(await page.evaluate(() => __ph.note) || ''));
    await page.click('#step');
    await page.waitForFunction(f => !__ph.navigating && __ph.shown.frame === f, shown, { timeout: 30000 });
    const lit = () => { const c = document.getElementById('display'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] > 128) n++; return n; };
    ok('… then the mask, assembled from the workers\' strips (mostly black, the movers white)', (await page.evaluate(() => __ph.note)) === null && (await page.evaluate(lit)) > 3 && (await page.evaluate(lit)) < 5000, await page.evaluate(lit));
    await page.click('label:has(input[name=param-view][value=diff])');
    ok('Raw diff view too', (await page.evaluate(() => __ph.note)) === null);
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
    await page.selectOption('#benchChangeValue', 'workers');
    await page.click('#benchChangeForm button[type=submit]');
    await page.evaluate(() => { for (const b of document.querySelectorAll('#benchSets input[type=checkbox]')) if (b.checked !== ['current', 'change:engine=workers'].includes(b.dataset.key)) b.click(); });
    await page.click('#benchRun');
    await page.waitForFunction(() => !__ph.bench.running && __ph.bench.result && __ph.bench.result.sets.length === 2, null, { timeout: 240000 });
    const [a, b] = await page.evaluate(() => __ph.bench.scores());
    ok('Benchmark: both engines find the same tracks', a.tracks === b.tracks && a.unknown === b.unknown && a.frames === b.frames, [a, b].map(x => ({ name: x.name, tracks: x.tracks, frames: x.frames, ms: x.ms })));

    // --- the slow lane: the same passes and candidates in both engines, no Mats left behind ---
    await page.evaluate(instrumentMats);
    const slowRun = await page.evaluate(async () => {
        const { createScene, greyToRgba } = await import('/src/synth.js');
        const { createPipeline } = await import('/src/pipeline.js');
        const { createWorkerPipeline } = await import('/src/workerPipeline.js');
        const opts = { width: 640, height: 360, noise: 2, frames: 70, camera: 'hover', seed: 12, shapes: 15,
            targets: [{ size: 3, contrast: 25, fx: 150, fy: 120, vx: 0.4, vy: 0.1 }, { size: 3, contrast: -25, fx: 450, fy: 240, vx: -0.6, vy: 0.2 }],
            trees: [{ fx: 300, fy: 200, r: 30, parallax: 0.1, sway: 2, swayPeriod: 31 }] };
        const run = async engine => {
            const s = createScene(opts);
            const params = { ...__ph.params, mode: 'everyFrame', slow: true, engine };
            const pipe = engine === 'workers' ? createWorkerPipeline(cv, params) : createPipeline(cv, params);
            if (pipe.ready) await pipe.ready;
            const out = {};
            for (let k = 0; k < s.frames; k++) {
                const f = s.frame(k);
                const r = (await pipe.push({ imageData: new ImageData(greyToRgba(f.grey), s.width, s.height), width: s.width, height: s.height,
                    time: k / 25, frame: k, seq: k, gap: 0, jump: k === 0, truth: f.truth })).result;
                if (!r) continue;
                out[r.frame] = { state: r.slow && r.slow.state, n: r.slow && r.slow.n, c: r.slow && r.slow.list ? r.slow.list.map(c => `${c.cx.toFixed(2)},${c.cy.toFixed(2)}`).sort().join(';') : null,
                    t: r.confirmed.filter(t => t.lane === 'slow').map(t => `${t.id}:${t.box.cx.toFixed(1)},${t.box.cy.toFixed(1)}`).join(';') };
            }
            pipe.dispose();
            return out;
        };
        const main = await run('main'), work = await run('workers');
        await new Promise(r => setTimeout(r, 1500));
        return { main, work, live: window.__liveMats() };
    });
    const frames = Object.keys(slowRun.main).filter(k => k in slowRun.work);
    const passes = frames.filter(k => slowRun.main[k].state === 'pass');
    const diff = frames.filter(k => JSON.stringify(slowRun.main[k]) !== JSON.stringify(slowRun.work[k]));
    ok('slow lane: the same passes, comparison lengths and candidates in both engines', frames.length >= 65 && passes.length >= 12
        && passes.some(k => slowRun.main[k].c) && diff.length === 0, { frames: frames.length, passes: passes.length, differ: diff.slice(0, 3).map(k => [k, slowRun.main[k], slowRun.work[k]]) });
    ok('… and the same slow tracks', frames.some(k => slowRun.main[k].t) && frames.every(k => slowRun.main[k].t === slowRun.work[k].t));
    ok('… no Mats left behind by either engine', slowRun.live === 0, slowRun.live);
    ok('no page errors', errors.length === 0, errors);
} finally {
    await browser.close();
}
