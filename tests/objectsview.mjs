// The objects UI: a card for each new object, the inspector (zoom, numbers, Keep tracking), Not
// an object, timeline lanes, the readout on the video, exports with labels, pause on a new
// object, the evidence settings, and the layout on a phone.
import fs from 'fs';
import { launch, ok, openApp, loadScene } from './lib/env.mjs';

// non-black pixels in a canvas (in the page)
const lit = sel => document.querySelector(sel) && (() => {
    const c = document.querySelector(sel), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 30 && d[i + 3] > 0) n++;
    return n;
})();

const browser = await launch();
try {
    const { page, errors } = await openApp(browser, { hash: 'mode=everyFrame', viewport: { width: 1440, height: 900 } });
    await loadScene(page, 'pan-dots');
    await page.waitForFunction(() => __ph.results.length >= 1, null, { timeout: 30000 });
    for (let i = 0; i < 30; i++) await page.click('#step');
    await page.waitForTimeout(400);
    const listIds = () => page.evaluate(() => [...document.querySelectorAll('#objectList li')].map(li => Number(li.dataset.oid)));

    // cards for new objects
    const cards = await page.locator('#cards .card').count();
    ok('a card on the video for each new object (at most 3)', cards >= 2 && cards <= 3, cards);
    ok('… with its picture', (await page.evaluate(lit, '#cards .card canvas')) > 100);
    ok('the readout on the video', await page.isVisible('#hud') && /fps · .* candidates · \d+ objects?/.test(await page.textContent('#hud')), await page.textContent('#hud'));
    ok('the Objects tab counts the objects on screen', await page.isVisible('#objBadge') && Number(await page.textContent('#objBadge')) >= 2, await page.textContent('#objBadge'));
    ok('list rows have a zoomed picture', (await page.evaluate(lit, '#objectList li:first-child .thumb')) > 100);

    // Not an object, from a card
    const hidden = Number(await page.getAttribute('#cards .card:last-child', 'data-oid'));
    await page.click('#cards .card:last-child button:has-text("Not an object")');
    await page.waitForTimeout(300);
    ok('Not an object (card): gone from the list', !(await listIds()).includes(hidden), { hidden, list: await listIds() });
    await page.click('#step');
    await page.waitForTimeout(400);
    const counts = await page.evaluate(id => ({ hud: Number(document.getElementById('hud').textContent.match(/(\d+) objects?/)[1]), others: __ph.lastResult.confirmed.filter(t => t.objectId !== id).length }), hidden);
    ok('… and not counted on the video', counts.hud === counts.others, counts);
    await page.click('#objFilter button[data-filter=hidden]');
    ok('… listed under Hidden', (await listIds()).includes(hidden));
    await page.click('#objFilter button[data-filter=all]');

    // the inspector
    const first = (await listIds())[0];
    await page.click('#objectList li:first-child');
    await page.click('#step');
    await page.waitForTimeout(300);
    ok('inspector: opens on a click in the list', await page.isVisible('#inspector') && (await page.textContent('#inspTitle')) === `#${first}`);
    ok('… a live zoom of the object', (await page.evaluate(lit, '#inspZoom')) > 2000 && (await page.isHidden('#inspNote')));
    ok('… its numbers', /Size.*Contrast.*Speed.*First seen.*Last seen/s.test(await page.textContent('#inspData')), await page.textContent('#inspData'));
    ok('… small charts of contrast, speed and σ', (await page.evaluate(lit, '#inspSpark')) > 50);
    await page.click('#inspZoomLevel button:has-text("×16")');
    ok('… zoom levels', (await page.getAttribute('#inspZoomLevel button:has-text("×16")', 'aria-pressed')) === 'true');
    ok('… the object is marked on the video', await page.evaluate(() => __ph.objectsView.open) === first);
    await page.click('#inspPin');
    ok('Keep tracking pins it', (await page.getAttribute('#inspPin', 'aria-pressed')) === 'true' && (await page.getAttribute('#objectList li:first-child', 'class')).includes('pinned'));
    ok('… and the list says so under Tracking', await page.click('#objFilter button[data-filter=pinned]').then(listIds).then(l => l.length === 1 && l[0] === first));
    await page.click('#objFilter button[data-filter=all]');

    // timeline lanes
    const lanes = await page.evaluate(() => document.getElementById('tlLanes').getBoundingClientRect().height);
    ok('timeline: a lane per object', lanes >= 8, lanes);
    const before = await page.evaluate(() => __ph.shown.frame);
    const hit = await page.evaluate(() => {
        // the first lane's first segment
        const c = document.getElementById('tlLanes'), r = c.getBoundingClientRect(), ctx = c.getContext('2d');
        const row = ctx.getImageData(0, 1, c.width, 1).data;
        for (let x = 0; x < c.width; x++) if (row[x * 4 + 3] > 150) return { x: r.left + (x + 2) / c.width * r.width, y: r.top + 1.5 };
        return null;
    });
    await page.mouse.click(hit.x, hit.y);
    await page.waitForFunction(() => !document.getElementById('stage').classList.contains('busy'), null, { timeout: 15000 });
    await page.waitForTimeout(800);
    ok('… a click on a lane goes there and inspects that object', (await page.evaluate(() => __ph.shown.frame)) < before && await page.isVisible('#inspector'), [before, await page.evaluate(() => __ph.shown.frame)]);

    // replaying after a jump back: the same objects again, no new cards
    await page.evaluate(() => document.getElementById('cards').replaceChildren());
    for (let i = 0; i < 12; i++) await page.click('#step');
    await page.waitForTimeout(300);
    ok('replaying footage seen before shows no cards', (await page.locator('#cards .card').count()) === 0);

    // go to a time or a frame
    await page.click('#time');
    await page.fill('#goTo', '#40');
    await page.press('#goTo', 'Enter');
    await page.waitForFunction(() => __ph.shown.frame === 40, null, { timeout: 15000 }).catch(() => {});
    ok('click on the time: go to a frame (#40)', (await page.evaluate(() => __ph.shown.frame)) === 40 && await page.isVisible('#time'), await page.evaluate(() => __ph.shown.frame));
    await page.keyboard.press('KeyG');
    await page.fill('#goTo', '0:01.2');
    await page.press('#goTo', 'Enter');
    await page.waitForFunction(() => __ph.shown.frame === 30, null, { timeout: 15000 }).catch(() => {});
    ok('G: go to a time (0:01.2 = frame 30 at 25 fps)', (await page.evaluate(() => __ph.shown.frame)) === 30, await page.evaluate(() => __ph.shown.frame));

    // exports keep the labels
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#exportObjects')]);
    const csv = fs.readFileSync(await dl.path(), 'utf8');
    ok('Objects CSV: a row per object with its label', csv.startsWith('id,label,first_frame') && csv.includes(`\n${hidden},not,`) && csv.includes(`\n${first},object,`), csv.split('\n').slice(0, 4));
    await page.click('#tab-stats');
    const [dj] = await Promise.all([page.waitForEvent('download'), page.click('#exportJson')]);
    const json = JSON.parse(fs.readFileSync(await dj.path(), 'utf8'));
    ok('detections JSON: the objects with their labels', json.objects.some(o => o.id === hidden && o.label === 'not') && json.objects.some(o => o.id === first && o.label === 'object'), json.objects);
    ok('… detections in frame order', json.detections.every((d, i) => i === 0 || d.frame >= json.detections[i - 1].frame));

    // confirmation by evidence: its settings replace N and M
    await page.click('#tab-settings');
    await page.click('#pConfirmation > summary');
    ok('N of M settings shown by default, the evidence ones not', await page.isVisible('#param-confirmN') && !(await page.isVisible('#param-minAge')));
    await page.click('label:has(input[name=param-confirmBy][value=evidence])');
    ok('Evidence: min age, min evidence and max gap instead', await page.isVisible('#param-minAge') && await page.isVisible('#param-minEvidence') && !(await page.isVisible('#param-confirmN')));
    ok('no page errors', errors.length === 0, errors);
    await page.close();

    // pause when a new object is confirmed
    {
        const { page: p, errors: e2 } = await openApp(browser, { hash: 'mode=everyFrame&pauseOnNew=true' });
        await loadScene(p, 'pan-dots');
        await p.waitForFunction(() => __ph.results.length >= 1, null, { timeout: 30000 });
        await p.click('#play');
        await p.waitForFunction(() => __ph.loop && !__ph.loop.playing, null, { timeout: 60000 });
        const at = await p.evaluate(() => ({ frame: __ph.shown.frame, objects: __ph.lastResult.confirmed.length }));
        ok('Pause on new object: playback stops at the first confirmation', at.objects >= 1 && at.frame < 20, at);
        ok('no page errors (pause)', e2.length === 0, e2);
        await p.close();
    }

    // a phone: one column, the inspector under the player, nothing wider than the screen
    {
        const { page: p, errors: e3 } = await openApp(browser, { hash: 'mode=everyFrame&cards=false', viewport: { width: 390, height: 844 } });
        await loadScene(p, 'pan-dots');
        await p.waitForFunction(() => __ph.results.length >= 1, null, { timeout: 30000 });
        for (let i = 0; i < 12; i++) await p.click('#step');
        await p.waitForTimeout(300);
        await p.click('#objectList li:first-child');
        ok('phone: the inspector goes under the player', await p.isVisible('#inspector') && await p.evaluate(() => document.getElementById('inspector').parentElement.classList.contains('stage-wrap')));
        ok('phone: no sideways scrolling', await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), await p.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]));
        ok('no page errors (phone)', e3.length === 0, e3);
        await p.close();
    }
} finally {
    await browser.close();
}
