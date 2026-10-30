// Settings panel: an explanation behind every setting's "?", "Explain settings" for all, and
// sliders that don't change when a touch scrolls the panel (real touch input via CDP).
import { launch, ok, openApp } from './lib/env.mjs';
import { PARAM_DEFS } from '../src/params.js';
import { HELP, SECTION_HELP } from '../src/help.js';

ok('every setting has an explanation', PARAM_DEFS.every(d => typeof HELP[d.key] === 'string' && HELP[d.key].length > 40), PARAM_DEFS.filter(d => !HELP[d.key]).map(d => d.key));

const browser = await launch();
try {
    const { page, errors } = await openApp(browser, { viewport: { width: 1280, height: 700 } });
    const n = await page.evaluate(() => document.querySelectorAll('.param .help-btn').length);
    ok('a "?" on every setting', n === PARAM_DEFS.length, n);
    ok('section explanations for presets and detection area', (await page.evaluate(() => document.querySelectorAll('[data-help] .help-btn').length)) === Object.keys(SECTION_HELP).length);
    const row = page.locator('.param', { has: page.locator('#param-threshold') });
    ok('explanations start hidden', await row.locator('.help').isHidden());
    await row.locator('.help-btn').click();
    ok('"?" shows the explanation', (await row.locator('.help').isVisible()) && (await row.locator('.help').textContent()).includes('grey'));
    await row.locator('.help-btn').click();
    ok('… and hides it again', await row.locator('.help').isHidden());
    await page.click('#helpAll');
    ok('"Explain settings" opens every explanation and section', (await page.evaluate(() => [...document.querySelectorAll('.help')].every(p => !p.hidden) && [...document.querySelectorAll('.panel details')].every(d => d.open))));
    await page.click('#helpAll');
    ok('… and hides them', await page.evaluate(() => [...document.querySelectorAll('.help')].every(p => p.hidden)));
    for (const d of await page.$$('.panel details')) await d.evaluate(el => { el.open = true; });

    // −/+ step exactly, clamped to the range
    const thr = () => page.evaluate(() => __ph.params.threshold);
    const t0 = await thr();
    await row.locator('.step-btn', { hasText: '+' }).click();
    ok('+ raises by one step', (await thr()) === t0 + 1, await thr());
    await row.locator('.step-btn', { hasText: '−' }).click();
    await row.locator('.step-btn', { hasText: '−' }).click();
    ok('− lowers by one step', (await thr()) === t0 - 1);
    const fb = page.locator('.param', { has: page.locator('#param-fbMax') });
    for (let i = 0; i < 30; i++) await fb.locator('.step-btn', { hasText: '+' }).click();
    ok('fractional steps stay exact and stop at the maximum', (await page.evaluate(() => __ph.params.fbMax)) === 3, await page.evaluate(() => __ph.params.fbMax));

    // touch, through the browser's own gesture handling
    const cdp = await page.context().newCDPSession(page);
    const touch = async (pts, wait = 16) => {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: pts[0][0], y: pts[0][1] }] });
        for (const [x, y] of pts.slice(1)) {
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] });
            await page.waitForTimeout(wait);
        }
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await page.waitForTimeout(100);
    };
    await page.locator('#param-features').scrollIntoViewIfNeeded();
    const box = await page.locator('#param-features').boundingBox();
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    const feat = () => page.evaluate(() => __ph.params.features);
    const scrollTop = () => page.evaluate(() => document.querySelector('.panel').scrollTop);
    const f0 = await feat(), s0 = await scrollTop();
    await touch([[cx + 40, cy], [cx + 40, cy - 20], [cx + 42, cy - 60], [cx + 44, cy - 120], [cx + 45, cy - 180]]);
    ok('a vertical swipe starting on a slider scrolls the panel, value unchanged', (await feat()) === f0 && (await scrollTop()) > s0, { value: await feat(), scrolled: (await scrollTop()) - s0 });
    // a slightly diagonal scroll gesture
    const s1 = await scrollTop();
    const b2 = await page.locator('#param-features').boundingBox();
    await touch([[b2.x + 60, b2.y + 8], [b2.x + 66, b2.y - 10], [b2.x + 74, b2.y - 40], [b2.x + 80, b2.y - 90]]);
    ok('… also when the swipe drifts sideways a little', (await feat()) === f0, { value: await feat(), scrolled: (await scrollTop()) - s1 });
    await page.locator('#param-features').scrollIntoViewIfNeeded();
    const b3 = await page.locator('#param-features').boundingBox();
    await touch([[b3.x + 30, b3.y + b3.height / 2]], 0);
    ok('a tap on a slider changes nothing', (await feat()) === f0, await feat());
    await touch([[b3.x + 30, b3.y + b3.height / 2], [b3.x + 45, b3.y + b3.height / 2], [b3.x + 60, b3.y + b3.height / 2], [b3.x + 30 + b3.width / 4, b3.y + b3.height / 2]]);
    const f1 = await feat();
    ok('a sideways drag changes the value, relative to where it started (no jump to the finger)', f1 > f0 && f1 < f0 + 900 * 0.3, { before: f0, after: f1 });

    // a mouse still clicks and drags as usual
    await page.locator('#param-features').scrollIntoViewIfNeeded();
    const b4 = await page.locator('#param-features').boundingBox();
    await page.mouse.click(b4.x + b4.width - 9, b4.y + b4.height / 2);
    ok('a mouse click sets the value where clicked', (await feat()) >= 950, await feat());
    ok('no page errors', errors.length === 0, errors);
} finally {
    await browser.close();
}
