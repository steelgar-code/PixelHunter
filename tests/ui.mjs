// The side panel and player: folding panels (remembered), playback speed, one frame back,
// bookmarks, the objects panel (details, pin), and updating a saved preset.
import { launch, ok, BASE_URL, loadScene } from './lib/env.mjs';
import { frameNumberClip, vfrFrameNumberClip, readFrameNumber } from './lib/clips.mjs';

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
    await open('mode=everyFrame&cards=false');

    // side panel tabs; settings sections fold, and stay folded after a reload
    ok('the Objects tab is shown first', await page.isVisible('#panel-objects') && !(await page.isVisible('#panel-settings')));
    await page.click('#tab-settings');
    ok('tabs switch the side panel', await page.isVisible('#panel-settings') && !(await page.isVisible('#panel-objects')));
    ok('every settings section can fold', await page.evaluate(() => [...document.querySelectorAll('#panel-settings > *')].every(el => el.tagName === 'DETAILS')));
    await page.click('#pArea > summary');
    ok('clicking a heading folds it', !(await page.evaluate(() => document.getElementById('pArea').open)));
    await page.click('#pPresets > summary .help-btn');
    ok('a "?" in a heading explains without folding', await page.evaluate(() => document.getElementById('pPresets').open && !document.querySelector('#pPresets .help').hidden));
    await open('mode=everyFrame&cards=false');
    ok('folded sections stay folded after a reload, and the tab is remembered', !(await page.evaluate(() => document.getElementById('pArea').open)) && await page.isVisible('#panel-settings'));
    await page.click('#pArea > summary');
    await page.click('#tab-objects');

    // synthetic scene, step a little
    await loadScene(page, 'pan-dots');
    await page.waitForFunction(() => __ph.results.length >= 1, null, { timeout: 30000 });
    for (let i = 0; i < 30; i++) await page.click('#step');
    const shown = () => page.evaluate(() => __ph.shown.frame);
    const f0 = await shown();

    // one frame back: the previous frame, with its detection result, drawn once (no rewind / replay)
    const r0 = await page.evaluate(() => __ph.renders);
    await page.click('#back');
    await page.waitForFunction(f => __ph.shown.frame === f - 1, f0, { timeout: 15000 });
    ok('‹ Back shows the previous frame', (await shown()) === f0 - 1, [f0, await shown()]);
    ok('… with its detection result', await page.evaluate(() => __ph.lastResult && __ph.lastResult.frame === __ph.shown.frame && __ph.lastResult.detect.ok));
    ok('… drawn once, not rewound and played forward', (await page.evaluate(() => __ph.renders)) - r0 <= 2, (await page.evaluate(() => __ph.renders)) - r0);
    ok('… and the tracks are confirmed again', await page.evaluate(() => __ph.lastResult.confirmed.length >= 2), await page.evaluate(() => __ph.lastResult.confirmed.length));
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
    ok('the bookmark is a tick on the timeline', (await page.locator('#tlMarks button').count()) === 1);
    for (let i = 0; i < 8; i++) await page.click('#step');
    await page.click('#tlMarks button');
    await page.waitForFunction(f => __ph.shown.frame === f, mark, { timeout: 15000 });
    ok('… one click on it goes there', (await shown()) === mark);

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
    const second = await page.evaluate(() => document.querySelector('#objectList li:nth-child(2) .oid').textContent);
    await page.click('#objectList li:nth-child(2)');
    ok('clicking an object opens it in the inspector', await page.isVisible('#inspector') && (await page.textContent('#inspTitle')) === second);
    await page.click('#inspFirst');
    await page.waitForFunction(() => !document.getElementById('stage').classList.contains('busy'), null, { timeout: 15000 });
    await page.waitForTimeout(800);
    ok('… First seen jumps back to where it was first seen', (await shown()) < firstFrame, [firstFrame, await shown()]);
    await page.click('#inspClose');
    ok('… × closes it', !(await page.isVisible('#inspector')));

    // pinning on the video, kept watching through a stop, then out of view
    {
        await loadScene(page, 'stop-go');
        await page.waitForFunction(() => __ph.results.length >= 1 && /stops/.test(document.getElementById('srcLabel').textContent), null, { timeout: 30000 });
        for (let i = 0; i < 20; i++) await page.click('#step');
        // the dot that will stop: started at 300,250 in frame 0
        const where = await page.evaluate(() => {
            const r = __ph.lastResult, t = r.confirmed.sort((a, b) => a.box.cy - b.box.cy)[0];
            const c = document.getElementById('display').getBoundingClientRect(), s = Math.min(c.width / 960, c.height / 540);
            return { id: t.objectId ?? t.id, x: c.left + (c.width - 960 * s) / 2 + (t.box.cx + 0.5) * s, y: c.top + (c.height - 540 * s) / 2 + (t.box.cy + 0.5) * s };
        });
        await page.mouse.click(where.x, where.y);
        await page.waitForTimeout(300);
        ok('a click on an object on the video opens it in the inspector', (await page.textContent('#inspTitle')) === `#${where.id}` && await page.isVisible('#inspector'));
        await page.mouse.dblclick(where.x, where.y);
        await page.waitForTimeout(300);
        const status = () => page.evaluate(id => [...document.querySelectorAll('#objectList li')].find(li => li.querySelector('.oid').textContent === `#${id}`)?.textContent || '', where.id);
        ok('a double click keeps tracking it (pinned)', /on screen/.test(await status()) && (await page.evaluate(id => document.querySelector('#objectList li:first-child .oid').textContent === `#${id}`, where.id)), await status());
        for (let i = 0; i < 25; i++) await page.click('#step');
        await page.waitForTimeout(300);
        ok('… it stops: kept watching where it stopped', /watching/.test(await status()), await status());
        for (let i = 0; i < 60; i++) await page.click('#step');
        await page.waitForTimeout(300);
        ok('… the camera pans on: out of view, still kept', /out of view/.test(await status()) && (await page.evaluate(id => __ph.lastResult.tracks.some(t => t.objectId === id && t.pinned), where.id)), await status());
        await page.mouse.click(where.x, where.y);         // nothing there now: no change
        ok('a click on empty video changes nothing', /out of view/.test(await status()));
        await page.click(`#objectList li:first-child .pin`);
        ok('★ unpins it', !(await page.evaluate(id => __ph.lastResult && document.querySelector('#objectList li.pinned'), where.id)));
    }

    // stepping a video file one frame at a time: constant and variable frame rate
    for (const [name, clip] of [['constant 25 fps', frameNumberClip({ fps: 25, seconds: 4 })], ['variable frame rate', vfrFrameNumberClip()]]) {
        await page.setInputFiles('#file', clip);
        const file = clip.split('/').pop();
        await page.waitForFunction(f => document.getElementById('srcLabel').textContent.startsWith(f + ' ·') && __ph.results.length >= 1 && !document.getElementById('step').disabled, file, { timeout: 30000 });
        const seen = [await page.evaluate(readFrameNumber)];
        for (let i = 0; i < 14; i++) {
            await page.click('#step');
            await page.waitForTimeout(120);
            seen.push(await page.evaluate(readFrameNumber));
        }
        ok(`${name}: every Step is exactly one frame`, seen.every((v, i) => i === 0 || v === seen[i - 1] + 1), seen);
        await page.click('#back');
        await page.waitForFunction(n => !document.getElementById('stage').classList.contains('busy'), null, { timeout: 15000 });
        await page.waitForTimeout(150);
        const b = await page.evaluate(readFrameNumber);
        ok(`${name}: ‹ Back is exactly one frame`, b === seen[seen.length - 1] - 1, [seen[seen.length - 1], b]);
        await page.click('#step');
        await page.waitForTimeout(200);
        ok(`${name}: … and Step right after it one frame forward again`, (await page.evaluate(readFrameNumber)) === b + 1, await page.evaluate(readFrameNumber));
        const backs = [await page.evaluate(readFrameNumber)];
        for (let i = 0; i < 5; i++) {
            await page.click('#back');
            await page.waitForFunction(() => !document.getElementById('stage').classList.contains('busy'), null, { timeout: 15000 });
            await page.waitForTimeout(150);
            backs.push(await page.evaluate(readFrameNumber));
        }
        ok(`${name}: five ‹ Backs in a row, one frame each`, backs.every((v, i) => i === 0 || v === backs[i - 1] - 1), backs);
    }

    // a pinned object across ‹ Back (tracking restarts): re-linked, same object; history and export
    {
        await loadScene(page, 'pan-dots');
        await page.waitForFunction(() => __ph.results.length >= 1 && /Pan · 2, 3/.test(document.getElementById('srcLabel').textContent), null, { timeout: 30000 });
        for (let i = 0; i < 30; i++) await page.click('#step');
        await page.waitForTimeout(300);
        const first = () => page.evaluate(() => document.querySelector('#objectList li:first-child')?.textContent || '');
        const oid = await page.evaluate(() => document.querySelector('#objectList li:first-child .oid').textContent);
        await page.click('#objectList li:first-child .pin');
        await page.click('#back');
        await page.waitForFunction(() => !document.getElementById('stage').classList.contains('busy'), null, { timeout: 15000 });
        await page.waitForTimeout(400);
        ok('after ‹ Back the pinned object is re-linked: same id, on screen', (await first()).startsWith(oid) && /on screen/.test(await first()), await first());
        await page.click('#objectList li:first-child .obtn button:first-child');
        ok('≡ opens its history', await page.isVisible('#objectHistory') && (await page.locator('#historyRows tr').count()) > 10);
        ok('… with the lost and re-linked events', /lost: tracking restarted/.test(await page.textContent('#historyRows')) && /re-linked/.test(await page.textContent('#historyRows')), (await page.textContent('#historyTitle')));
        const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#historyCsv')]);
        const csv = await (await import('fs')).promises.readFile(await dl.path(), 'utf8');
        ok('CSV export: a row per frame, with size, contrast and speed', csv.startsWith('frame,time,track,state,seen,early,x,y,w,h,contrast,speed') && csv.split('\n').length > 10, csv.split('\n').slice(0, 3));
        await page.click('#historyClose');
        ok('× closes it', !(await page.isVisible('#objectHistory')));
        await page.click('#objectList li:first-child .pin');
    }

    // the timeline: hover shows the time; the shortcut line is there
    {
        const box = await page.locator('#timeline').boundingBox();
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        ok('hovering the timeline shows the time there', await page.isVisible('#tlHover') && /0:0\d\.\d{3} #\d+/.test(await page.textContent('#tlHover')), await page.textContent('#tlHover'));
        await page.mouse.move(box.x + box.width / 2, box.y - 60);
        ok('… and hides when leaving', !(await page.isVisible('#tlHover')));
        ok('keyboard shortcuts are listed under the player', /Space.*play.*B.*bookmark/s.test(await page.textContent('.keys')));
    }

    // speed
    await page.click('#tab-settings');
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
