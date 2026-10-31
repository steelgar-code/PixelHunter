// The side panel and player: folding panels (remembered), playback speed, one frame back,
// bookmarks, the objects panel (details, pin), and updating a saved preset.
import { launch, ok, BASE_URL } from './lib/env.mjs';

const browser = await launch();
try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    const open = async (hash = '') => {
        await page.goto(`${BASE_URL}#${hash}`);
        await page.waitForFunction(() => window.__ph && window.__ph.ready, null, { timeout: 90000 });
    };
    await open('mode=everyFrame');

    // panels fold, and stay folded after a reload
    ok('every side panel can fold', await page.evaluate(() => [...document.querySelectorAll('.panel > *')].every(el => el.tagName === 'DETAILS')));
    await page.click('#pStats > summary');
    ok('clicking a heading folds it', !(await page.evaluate(() => document.getElementById('pStats').open)));
    await page.click('#pPresets > summary .help-btn');
    ok('a "?" in a heading explains without folding', await page.evaluate(() => document.getElementById('pPresets').open && !document.querySelector('#pPresets .help').hidden));
    await open('mode=everyFrame');
    ok('folded panels stay folded after a reload', !(await page.evaluate(() => document.getElementById('pStats').open)));
    await page.click('#pStats > summary');

    // synthetic scene, step a little
    await page.selectOption('#scene', 'pan-dots');
    await page.click('#openScene');
    await page.waitForFunction(() => __ph.results.length >= 1, null, { timeout: 30000 });
    for (let i = 0; i < 30; i++) await page.click('#step');
    const shown = () => page.evaluate(() => __ph.shown.frame);
    const f0 = await shown();

    // one frame back: the previous frame, with its detection result
    await page.click('#back');
    await page.waitForFunction(f => __ph.shown.frame === f - 1, f0, { timeout: 15000 });
    ok('‹ Back shows the previous frame', (await shown()) === f0 - 1, [f0, await shown()]);
    ok('… with its detection result', await page.evaluate(() => __ph.lastResult && __ph.lastResult.frame === __ph.shown.frame && __ph.lastResult.detect.ok));
    await page.keyboard.press('ArrowLeft');
    await page.waitForFunction(f => __ph.shown.frame === f - 2, f0, { timeout: 15000 });
    ok('← does the same', (await shown()) === f0 - 2);

    // bookmarks
    await page.keyboard.press('KeyB');
    const mark = await shown();
    for (let i = 0; i < 12; i++) await page.click('#step');
    ok('B bookmarks the frame', (await page.locator('#bookmarks .chip').count()) === 1 && (await page.textContent('#bookmarks')).includes(`#${mark}`));
    await page.click('#bookmarks .chip .go');
    await page.waitForFunction(f => __ph.shown.frame === f, mark, { timeout: 15000 });
    ok('one click on a bookmark goes back to it', (await shown()) === mark);
    await page.click('#bookmark');
    ok('the same frame is not bookmarked twice', (await page.locator('#bookmarks .chip').count()) === 1);

    // objects
    for (let i = 0; i < 6; i++) await page.click('#step');
    await page.waitForTimeout(400);
    const n = await page.locator('#objectList li').count();
    ok('confirmed objects are listed', n >= 2, n);
    const text = await page.textContent('#objectList li:first-child');
    ok('… with size, contrast, speed and when seen', /\d+×\d+ px · [+−-]?\d+ grey/.test(text) && /px\/f/.test(text) && /frames/.test(text), text);
    // pan-dots: a 3 px dot of contrast +60 and a 2 px dot of −45 (contrast against the ring is lower after blur by the sensor)
    const contrasts = await page.evaluate(() => [...document.querySelectorAll('#objectList li')].map(li => Number(li.textContent.match(/([+−-]?\d+) grey/)[1].replace('−', '-'))));
    ok('… the bright dot positive, the dark one negative', contrasts.some(c => c > 15) && contrasts.some(c => c < -15), contrasts);
    const lastId = await page.evaluate(() => document.querySelector('#objectList li:last-child .oid').textContent);
    await page.click('#objectList li:last-child .pin');
    ok('★ pins an object to the top', (await page.evaluate(() => document.querySelector('#objectList li:first-child .oid').textContent)) === lastId
        && (await page.getAttribute('#objectList li:first-child', 'class')).includes('pinned'));
    const firstFrame = await shown();
    await page.click('#objectList li:nth-child(2)');
    await page.waitForTimeout(1500);
    ok('clicking an object jumps to its last frame', (await shown()) <= firstFrame);

    // speed
    await page.click('label:has(input[name=param-speed][value="3"])');
    ok('speed ×3 reaches the player', await page.evaluate(() => __ph.loop.speed === 3 && __ph.params.speed === '3'));
    await page.click('label:has(input[name=param-speed][value="1"])');

    // presets: Update
    await page.evaluate(() => __ph.setZones('exclude', [{ x: 0, y: 0, w: 0.1, h: 0.1 }]));
    await page.fill('#presetName', 'My OSD');
    await page.uncheck('#saveSettings');
    await page.click('#savePreset');
    await page.check('#saveSettings');
    ok('Update is off while nothing has changed', await page.isDisabled('#updateUserPreset'));
    await page.evaluate(() => __ph.setZones('exclude', [{ x: 0, y: 0, w: 0.1, h: 0.1 }, { x: 0.9, y: 0.9, w: 0.1, h: 0.1 }]));
    ok('changing the zones turns Update on', !(await page.isDisabled('#updateUserPreset')));
    await page.click('#updateUserPreset');
    const saved = await page.evaluate(() => __ph.userPresets.find(p => p.name === 'My OSD'));
    ok('Update saves the new zones into the preset, still zones only', saved.zones.length === 2 && !saved.values, saved);
    ok('… and turns itself off', await page.isDisabled('#updateUserPreset'));
    await page.evaluate(() => __ph.applyPreset('highest'));
    ok('a settings change doesn\'t turn Update on for a zones-only preset', await page.isDisabled('#updateUserPreset'));
    ok('no page errors', errors.length === 0, errors);
    await ctx.close();
} finally {
    await browser.close();
}
