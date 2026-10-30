// Playback and the frame loop: file source, first frame, play, step, seek, dropped frames in
// real-time mode, no skipped frames in every-frame mode (rate control and stepping).
import { launch, ok, openApp, sleep } from './lib/env.mjs';
import { frameNumberClip, readFrameNumber } from './lib/clips.mjs';

const clip = frameNumberClip({ fps: 25, seconds: 4 });
const browser = await launch();

async function openClip(opts) {
    const app = await openApp(browser, opts);
    await app.page.setInputFiles('#file', clip);
    await app.page.waitForFunction(() => __ph.frames.length >= 1, null, { timeout: 15000 });
    return app;
}

// Delivered frames after the first `skip`, as gaps and frame-number steps.
const continuity = (frames, skip = 0) => {
    const f = frames.slice(skip);
    const gaps = f.reduce((a, x) => a + (x.jump ? 0 : x.gap), 0);
    const steps = f.slice(1).map((x, i) => x.frame - f[i].frame);
    return { n: f.length, gaps, nonUnit: steps.filter(s => s !== 1).length,
        at: f.filter(x => x.gap && !x.jump).map(x => [x.seq, x.frame, x.gap]) };
};

try {
    {
        const { page, errors } = await openClip();
        await page.waitForFunction(() => __ph.frames.length >= 2, null, { timeout: 5000 });
        const first = await page.evaluate(() => ({ label: document.getElementById('srcLabel').textContent, frames: __ph.frames.length,
            play: document.getElementById('play').disabled, empty: document.getElementById('empty').hidden }));
        ok('file opens, first frame shown before playing', first.frames >= 1 && first.empty && !first.play, first);
        ok('source label has name and size', first.label.includes('framenum') && first.label.includes('320×240'), first.label);
        ok('first frame is frame 0 on the display, frame 1 loaded behind it', (await page.evaluate(readFrameNumber)) === 0
            && (await page.evaluate(() => __ph.shown.frame === 0 && __ph.lastFrame.frame === 1)));

        await page.click('#play');
        await sleep(1500);
        const s = await page.evaluate(() => __ph.stats);
        ok('plays: source fps measured as 25', s && Math.abs(s.sourceFps - 25) < 0.5, s);
        ok('plays: frames delivered at about 25 fps', s.processedFps >= 18 && s.processedFps <= 32, s.processedFps);
        ok('plays: (almost) nothing dropped with light processing', s.dropped <= 3, s);

        await page.click('#play');                          // pause
        await sleep(200);
        const before = await page.evaluate(readFrameNumber);
        const seen = [];
        for (let i = 0; i < 5; i++) {
            await page.click('#step');
            await page.waitForFunction(n => __ph.lastFrame.seq > n, (await page.evaluate(() => __ph.lastFrame.seq)) - 1);
            await sleep(100);
            seen.push({ drawn: await page.evaluate(readFrameNumber), shown: await page.evaluate(() => __ph.shown.frame), ...(await page.evaluate(() => __ph.lastFrame)) });
        }
        ok('step: each step draws the next frame', seen.every((x, i) => x.drawn === before + 1 + i), { before, drawn: seen.map(x => x.drawn) });
        ok('step: the shown frame is one behind the newest (one frame of latency)', seen.every(x => x.shown === x.drawn && x.frame === x.drawn + 1), seen.map(x => [x.frame, x.shown]));
        ok('step: no gap, no jump', seen.every(x => x.gap === 0 && !x.jump));
        ok('step: stays paused', await page.evaluate(() => document.getElementById('video').paused && !__ph.loop.playing));

        await page.keyboard.press('ArrowRight');
        await page.waitForFunction(n => __ph.lastFrame.frame === n, seen[4].frame + 1, { timeout: 5000 }).catch(() => {});
        await sleep(100);
        ok('→ key steps too', (await page.evaluate(readFrameNumber)) === seen[4].drawn + 1);

        const seq = await page.evaluate(() => __ph.lastFrame.seq);
        await page.$eval('#timeline', el => { el.value = 750; el.dispatchEvent(new Event('input')); el.dispatchEvent(new Event('change')); });
        await page.waitForFunction(n => __ph.lastFrame.seq > n, seq, { timeout: 5000 });
        const j = await page.evaluate(() => __ph.lastFrame);
        ok('seek from the timeline: next frame is marked as a jump', j.jump && Math.abs(j.time - 3) < 0.1, j);
        ok('no page errors', errors.length === 0, errors);
        await page.close();
    }
    {
        const { page } = await openClip({ hash: 'mode=realtime&simLoad=60' });
        await page.click('#play');
        await sleep(2500);
        const s = await page.evaluate(() => __ph.stats);
        ok('real-time with 60 ms load: frames are dropped', s.dropped >= 10, s);
        ok('real-time: playback rate stays 1', s.rate === 1);
        await page.close();
    }
    {
        const { page } = await openClip({ hash: 'mode=everyFrame&simLoad=60' });
        await page.click('#play');
        await page.waitForFunction(() => __ph.frames.length >= 40, null, { timeout: 30000 });
        const c = continuity(await page.evaluate(() => __ph.frames), 1);
        const s = await page.evaluate(() => __ph.stats);
        ok('every frame with 60 ms load: no frame skipped', c.gaps === 0 && c.nonUnit === 0, c);
        ok('every frame: playback slowed down', s.rate > 0.1 && s.rate < 0.6, s.rate);
        await page.close();
    }
    {
        const { page } = await openClip({ hash: 'mode=everyFrame&simLoad=500' });
        await page.click('#play');
        await page.waitForFunction(() => __ph.frames.length >= 8, null, { timeout: 30000 });
        const c = continuity(await page.evaluate(() => __ph.frames), 1);
        const s = await page.evaluate(() => __ph.stats);
        ok('every frame with 500 ms load: steps frame by frame', s.stepping, s);
        ok('stepping: no frame skipped', c.gaps === 0 && c.nonUnit === 0, c);
        await page.click('#play');                          // pause
        await sleep(1200);
        const n1 = await page.evaluate(() => __ph.frames.length);
        await sleep(1200);
        ok('stepping stops on pause', (await page.evaluate(() => __ph.frames.length)) === n1);
        await page.close();
    }
    for (const fps of [30, 60]) {
        const { page } = await openApp(browser);
        await page.setInputFiles('#file', frameNumberClip({ fps, seconds: 2, gop: fps * 2 }));
        await page.waitForFunction(() => __ph.frames.length >= 1 && __ph.stats, null, { timeout: 15000 });
        await page.waitForFunction(() => __ph.stats.sourceFps !== null, null, { timeout: 5000 }).catch(() => {});
        const r = await page.evaluate(() => ({ fps: __ph.stats.sourceFps, first: __ph.lastFrame }));
        ok(`${fps} fps file: frame rate known before playing`, r.fps && Math.abs(r.fps - fps) < 0.5, r);
        await page.waitForFunction(() => __ph.lastFrame.seq >= 1, null, { timeout: 5000 });
        await page.click('#step');
        await page.waitForFunction(() => __ph.lastFrame.seq >= 2, null, { timeout: 5000 });
        await sleep(100);
        ok(`${fps} fps file: first step shows frame 1`, (await page.evaluate(readFrameNumber)) === 1);
        await page.close();
    }
} finally {
    await browser.close();
}
