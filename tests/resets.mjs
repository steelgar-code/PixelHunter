// When the frame history starts over mid-playback, the note names the cause.
import { launch, ok, openApp } from './lib/env.mjs';

const browser = await launch();
try {
    const { page, errors } = await openApp(browser, { hash: 'mode=everyFrame&stride=1&procWidth=0&estWidth=320' });
    await page.selectOption('#scene', 'pan-dots');
    await page.click('#openScene');
    await page.waitForFunction(() => __ph.results.length >= 1, null, { timeout: 30000 });
    const reason = () => page.evaluate(() => __ph.lastResult && __ph.lastResult.detect.reason);
    const first = await page.evaluate(() => __ph.results[0].detectReason);
    ok('at the start: plain "no previous frame"', first === 'no previous frame', first);
    for (let i = 0; i < 4; i++) await page.click('#step');
    ok('then detection runs', (await reason()) === null, await reason());

    // a seek on the timeline
    // dragging (not yet released) seeks directly; releasing while paused would refill the history
    await page.$eval('#timeline', el => { el.value = 500; el.dispatchEvent(new Event('input')); });
    await page.waitForTimeout(200);
    await page.click('#step');
    await page.waitForFunction(() => __ph.lastResult && /restarted/.test(__ph.lastResult.detect.reason || ''), null, { timeout: 10000 });
    ok('after a seek', /no previous frame \(restarted: seek\)/.test(await reason()), await reason());
    for (let i = 0; i < 3; i++) await page.click('#step');

    // the notes of the next n frames
    const steps = async n => {
        const out = [];
        for (let i = 0; i < n; i++) { await page.click('#step'); out.push(await reason()); }
        return out;
    };
    await page.click('label:has(input[name=param-procWidth][value="640"])');
    let seen = await steps(4);
    ok('after changing the processing width', seen.some(r => /^no previous frame \(restarted: processing width changed\)$/.test(r || '')) && seen.at(-1) === null, seen);
    const n0 = await page.evaluate(() => __ph.results.length);
    await page.locator('.param', { has: page.locator('#param-stride') }).locator('.step-btn', { hasText: '+' }).click();
    seen = await steps(6);
    // Step refills the history silently after the reset: the notes are on the frames in between
    const notes = await page.evaluate(n => __ph.results.slice(n).map(r => r.detectReason), n0);
    ok('after changing the frame stride, while the history refills', notes.some(r => /^no previous frame \(restarted: frame stride changed\)$/.test(r || ''))
        && notes.some(r => /^waiting for 2 frames before \(restarted: frame stride changed\)$/.test(r || '')), notes);
    ok('… and Step shows the next frame with its detection result again', seen.every(r => r === null), seen);
    ok('no page errors', errors.length === 0, errors);
} finally {
    await browser.close();
}
