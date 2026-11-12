// Every frame in real time: the note on the video when real time processes under 80 % of the
// frames for a few seconds (and none when it keeps up, none in Every frame), dismissing it; the
// Auto engine (Workers with four cores or more and module workers, else Main thread; Main thread
// without a banner when the workers cannot start).
import { launch, ok, openApp, showTab } from './lib/env.mjs';
import { frameNumberClip } from './lib/clips.mjs';

const clip = frameNumberClip({ fps: 25, seconds: 10 });
const browser = await launch();
try {
    // --- the note: a simulated load of 90 ms a frame keeps up with ~40 % of 25 fps ---
    {
        const { page, errors } = await openApp(browser, { hash: 'mode=realtime&simLoad=90' });
        await page.setInputFiles('#file', clip);
        await page.waitForFunction(() => __ph.results.length >= 1 && document.getElementById('loading').hidden, null, { timeout: 30000 });
        await page.click('#play');
        await page.waitForFunction(() => __ph.lag && __ph.lag.shown, null, { timeout: 9000 }).catch(() => {});
        const lag = await page.evaluate(() => __ph.lag);
        const text = await page.textContent('#lagText');
        ok('real time keeping up with under 80 % of the frames: a note on the video', lag.shown && lag.share < 0.8 && await page.isVisible('#lagNote'), lag);
        ok('… saying what it costs and what helps', /% of the frames/.test(text) && /further apart/.test(text) && /Engine: Workers/.test(text) && /Processing width/.test(text) && /inclusion zone/.test(text), text);
        await page.click('#lagClose');
        await page.waitForTimeout(1500);
        ok('… dismissed: gone, and not back for this source', !(await page.isVisible('#lagNote')) && (await page.evaluate(() => __ph.lag.dismissed)));
        ok('no page errors', errors.length === 0, errors);
        await page.close();
    }
    // --- keeping up, and Every frame: no note ---
    for (const [hash, what] of [['mode=realtime', 'real time keeping up'], ['mode=everyFrame&simLoad=90', 'Every frame (never drops frames)']]) {
        const { page } = await openApp(browser, { hash });
        await page.setInputFiles('#file', clip);
        await page.waitForFunction(() => __ph.results.length >= 1 && document.getElementById('loading').hidden, null, { timeout: 30000 });
        await page.click('#play');
        let seen = false;
        for (let i = 0; i < 12; i++) { await page.waitForTimeout(500); seen ||= await page.evaluate(() => !!(__ph.lag && __ph.lag.shown)); }
        ok(`${what}: no note`, !seen, await page.evaluate(() => __ph.lag));
        await page.close();
    }

    // --- Auto engine ---
    {
        const { page, errors } = await openApp(browser, { hash: 'engine=auto' });
        await showTab(page, 'settings');
        const cores = await page.evaluate(() => navigator.hardwareConcurrency);
        await page.setInputFiles('#file', clip);
        await page.waitForFunction(() => __ph.pipeline && (!__ph.pipeline.engine || __ph.pipeline.state === 'ready') && document.getElementById('loading').hidden, null, { timeout: 60000 });
        const eng = await page.evaluate(() => __ph.pipeline.engine || 'main');
        ok(`Auto with ${cores} cores: ${cores >= 4 ? 'Workers' : 'Main thread'}`, eng === (cores >= 4 ? 'workers' : 'main'), eng);
        ok('… Stats say Auto and the engine', /^Auto: (Workers|Main thread)/.test(await page.textContent('#stEngine')), await page.textContent('#stEngine'));
        ok('… worker count applies with Auto', !(await page.evaluate(() => document.getElementById('param-workers').closest('.param').classList.contains('inapplicable'))));
        ok('no page errors', errors.length === 0, errors);
        await page.close();
    }
    {
        // two cores: Main thread
        const ctx = await browser.newContext();
        await ctx.addInitScript(() => Object.defineProperty(Navigator.prototype, 'hardwareConcurrency', { get: () => 2 }));
        const page = await ctx.newPage();
        await page.goto(`${process.env.BASE_URL || 'http://localhost:8765/'}#engine=auto`);
        await page.waitForFunction(() => window.__ph && window.__ph.ready, null, { timeout: 90000 });
        await page.setInputFiles('#file', clip);
        await page.waitForFunction(() => __ph.pipeline && document.getElementById('loading').hidden, null, { timeout: 60000 });
        ok('Auto with 2 cores: Main thread', await page.evaluate(() => !__ph.pipeline.engine));
        await ctx.close();
    }
    {
        // workers that cannot start: Main thread, no banner
        const ctx = await browser.newContext();
        await ctx.route('**/procWorker.js', r => r.fulfill({ status: 200, contentType: 'text/javascript', body: 'throw new Error("no workers here")' }));
        const page = await ctx.newPage();
        await page.goto(`${process.env.BASE_URL || 'http://localhost:8765/'}#engine=auto`);
        await page.waitForFunction(() => window.__ph && window.__ph.ready, null, { timeout: 90000 });
        await page.setInputFiles('#file', clip);
        await page.waitForFunction(() => __ph.pipeline && !__ph.pipeline.engine && __ph.results.length >= 1, null, { timeout: 60000 }).catch(() => {});
        const st = await page.evaluate(() => ({ engine: __ph.pipeline.engine || 'main', results: __ph.results.length, banner: !document.getElementById('banner').hidden }));
        ok('Auto, workers failing to start: Main thread, frames processed, no banner', st.engine === 'main' && st.results >= 1 && !st.banner, st);
        await ctx.close();
    }
} finally {
    await browser.close();
}
