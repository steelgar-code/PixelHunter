// Camera motion in the app, end to end: a synthetic handheld scene encoded as H.264, played in
// every-frame mode; the fitted H per frame against the ground truth, the debug views.
import { launch, ok, openApp, sleep } from './lib/env.mjs';
import { sceneClip } from './lib/clips.mjs';

const W = 640, H = 360;
const clip = await sceneClip({ width: W, height: H, frames: 50, camera: 'handheld', seed: 11 }, { crf: 20 });
const browser = await launch();
try {
    const { page, errors } = await openApp(browser, { hash: 'mode=everyFrame&view=points' });
    await page.setInputFiles('#file', clip.path);
    await page.waitForFunction(() => __ph.results.length >= 1, null, { timeout: 20000 });
    await page.click('#play');
    await page.waitForFunction(() => !__ph.loop.playing, null, { timeout: 60000 });
    const res = await page.evaluate(() => __ph.results);
    const { maxCornerDiff } = await import('../src/homography.js');
    // result for frame t carries H(t → t+1) = truth[t + 1].H
    const errs = res.filter(r => r.ok && clip.truth[r.frame + 1]).map(r => maxCornerDiff(r.H, clip.truth[r.frame + 1].H, W, H));
    errs.sort((a, b) => a - b);
    const frames = new Set(res.map(r => r.frame));
    ok('every frame processed once, in order', res.length === 49 && frames.size === 49 && res.every((r, i) => r.frame === i), res.length);
    ok('no frame skipped by ego-motion', res.every(r => r.ok), res.filter(r => !r.ok).map(r => [r.frame, r.reason]));
    ok('H.264 (CRF 20): corner error < 1 px', errs[errs.length - 1] < 1, { med: +errs[errs.length >> 1].toFixed(3), max: +errs[errs.length - 1].toFixed(3) });

    const st = await page.evaluate(() => ({ points: document.getElementById('stPoints').textContent,
        inliers: document.getElementById('stInliers').textContent, skipped: document.getElementById('stSkipped').textContent }));
    ok('stats show points, inliers and skipped frames', Number(st.points) > 100 && /%/.test(st.inliers) && st.skipped === '0', st);

    // tracked points view: green dots on the overlay
    const seq = await page.evaluate(() => __ph.lastFrame.seq);
    await page.$eval('#timeline', el => { el.value = 400; el.dispatchEvent(new Event('input')); el.dispatchEvent(new Event('change')); });
    await page.waitForFunction(n => __ph.lastFrame.seq > n, seq, { timeout: 5000 });
    ok('seek after the end: jump flagged', await page.evaluate(() => __ph.lastFrame.jump));
    await page.click('#step');
    await page.waitForFunction(() => __ph.lastResult && __ph.lastResult.egoNext.ok, null, { timeout: 5000 });
    await sleep(100);
    const green = await page.evaluate(() => {
        const c = document.getElementById('overlay');
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        let n = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 200 && d[i + 1] > 150 && d[i] < 120) n++;
        return n;
    });
    ok('tracked points view draws inliers in green', green > 500, green);

    // stabilised view needs the frame before too: one more step, then no note
    await page.click('#step');
    await page.waitForFunction(() => __ph.lastResult && __ph.lastResult.egoPrev, null, { timeout: 5000 });
    await page.click('#tab-settings');
    await page.click('label:has(input[name=param-view][value=stabilised])');
    await sleep(100);
    const stab = await page.evaluate(() => ({ note: __ph.note, view: __ph.params.view }));
    ok('stabilised view renders without a note', stab.view === 'stabilised' && stab.note === null, stab);
    ok('no page errors', errors.length === 0, errors);
    await page.close();
} finally {
    await browser.close();
}
