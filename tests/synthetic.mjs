// Synthetic scenes in the app: picker, playback, ground truth and candidate overlays, live
// score, debug views.
import { launch, ok, openApp, sleep } from './lib/env.mjs';

const countColour = (page, test, minAlpha = 150) => page.evaluate(([src, a]) => {
    const fn = new Function('r', 'g', 'b', `return ${src};`);
    const c = document.getElementById('overlay');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i + 3] > a && fn(d[i], d[i + 1], d[i + 2])) n++;
    return n;
}, [test, minAlpha]);

const browser = await launch();
try {
    const { page, errors } = await openApp(browser, { hash: 'mode=everyFrame&view=original' });
    const options = await page.$$eval('#scene option', os => os.map(o => o.value));
    ok('scene picker lists the presets', options.includes('pan-dots') && options.includes('static-scene'), options);
    await page.selectOption('#scene', 'pan-dots');
    await page.click('#openScene');
    await page.waitForFunction(() => __ph.results.length >= 1, null, { timeout: 30000 });
    const first = await page.evaluate(() => ({ label: document.getElementById('srcLabel').textContent, shown: __ph.shown.frame,
        play: document.getElementById('play').disabled, time: document.getElementById('time').textContent }));
    ok('scene loads, frame 0 shown, transport enabled', first.label.includes('960×540') && first.shown === 0 && !first.play && first.time.endsWith('0:06.000'), first);

    await page.click('#play');
    await page.waitForFunction(() => __ph.shown.frame >= 30, null, { timeout: 30000 });
    await page.click('#play');
    await sleep(300);
    const frames = await page.evaluate(() => __ph.frames.map(f => f.frame));
    ok('every-frame mode: frames in order, none skipped', frames.every((f, i) => f === i), frames.slice(0, 40));
    const st = await page.evaluate(() => ({ score: __ph.stats.score, row: !document.getElementById('rowScore').hidden, text: document.getElementById('stScore').textContent,
        cand: document.getElementById('stCand').textContent }));
    ok('live score shown for synthetic scenes', st.row && /% hit/.test(st.text) && st.score.frames >= 28, st);
    ok('targets found (basic mode)', st.score.hitRate > 0.9, st.score);

    const cyan = await countColour(page, 'b > 200 && g > 180 && r < 140');
    const yellow = await countColour(page, 'r > 200 && g > 170 && b < 140', 100);
    const magenta = await countColour(page, 'r > 200 && g < 120 && b > 180');
    ok('ground truth circles drawn', cyan > 50, cyan);
    ok('candidate boxes drawn (faint)', yellow > 50, yellow);
    ok('confirmed tracks drawn', magenta > 50, magenta);
    await page.click('#param-showTruth');
    await sleep(100);
    ok('ground truth toggles off', (await countColour(page, 'b > 200 && g > 180 && r < 140')) === 0);

    for (const view of ['diff', 'mask']) {
        await page.click(`label:has(input[name=param-view][value=${view}])`);
        await sleep(100);
        const px = await page.evaluate(() => {
            const c = document.getElementById('display');
            const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
            let bright = 0;
            for (let i = 0; i < d.length; i += 4) if (d[i] > 200) bright++;
            return { bright, total: d.length / 4 };
        });
        ok(`${view} view: mostly dark, some bright pixels`, px.bright > 0 && px.bright < px.total * 0.05, px);
    }

    const before = await page.evaluate(() => __ph.shown.frame);
    await page.click('#step');
    await sleep(200);
    ok('step advances one frame', (await page.evaluate(() => __ph.shown.frame)) === before + 1);
    await page.$eval('#timeline', el => { el.value = 500; el.dispatchEvent(new Event('input')); el.dispatchEvent(new Event('change')); });
    await sleep(200);
    const j = await page.evaluate(() => __ph.lastFrame);
    ok('timeline seek jumps', j.jump && j.frame === 75, j);

    const s = await page.evaluate(() => { document.querySelector('#param-threshold').value = 40; document.querySelector('#param-threshold').dispatchEvent(new Event('input')); return __ph.stats.score; });
    await sleep(300);
    ok('changing a detection setting restarts the score', (await page.evaluate(() => __ph.score.summary().frames)) === 0, s && s.frames);
    // processing width: 960 px source processed at 640 px, ground truth scaled to match
    await page.evaluate(() => { const t = document.querySelector('#param-threshold'); t.value = 20; t.dispatchEvent(new Event('input')); });
    await page.click('label:has(input[name=param-procWidth][value="640"])');
    await page.click('label:has(input[name=param-view][value=original])');
    await page.$eval('#timeline', el => { el.value = 0; el.dispatchEvent(new Event('input')); el.dispatchEvent(new Event('change')); });
    await sleep(200);
    await page.click('#play');
    await page.waitForFunction(() => __ph.score.summary().frames >= 30, null, { timeout: 60000 });
    await page.click('#play');
    await sleep(200);
    const pw = await page.evaluate(() => ({ w: __ph.lastResult.width, h: __ph.lastResult.height, scale: __ph.lastResult.scale,
        canvas: document.getElementById('display').width, score: __ph.score.summary() }));
    ok('processing width 640: frames processed at 640×360', pw.w === 640 && pw.h === 360 && pw.canvas === 640 && Math.abs(pw.scale - 2 / 3) < 1e-9, pw);
    // downscaling dilutes small targets (the 2 px one most): most, not all, are still found
    ok('processing width 640: targets still matched against scaled truth', pw.score.hitRate > 0.6, pw.score);
    ok('no page errors', errors.length === 0, errors);
} finally {
    await browser.close();
}
