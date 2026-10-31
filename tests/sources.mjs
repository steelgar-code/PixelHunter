// Video from a URL: same origin, another site that allows reading (CORS) and one that doesn't,
// links that are web pages rather than videos, #src= in the address. User presets with zones.
import http from 'http';
import fs from 'fs';
import path from 'path';
import { launch, ok, openApp, BASE_URL } from './lib/env.mjs';
import { frameNumberClip, readFrameNumber, CACHE } from './lib/clips.mjs';
import { checkVideoUrl } from '../src/sources.js';
import { presetFrom, upsert, remove, find, describe, changesOf, normalizePreset, toFile, fromFile } from '../src/userPresets.js';
import { defaults } from '../src/params.js';

// --- Node: URL checks, user presets ---
ok('a YouTube link is explained, not tried', /web page with a player/.test(checkVideoUrl('https://www.youtube.com/watch?v=x') || ''));
ok('not a URL', /complete URL/.test(checkVideoUrl('video.mp4') || ''));
ok('only http(s)', /http/.test(checkVideoUrl('ftp://x.org/a.mp4') || ''));
ok('a direct link passes', checkVideoUrl('https://example.org/clips/a.mp4') === null);
{
    const p = { ...defaults(), threshold: 14, zones: [{ x: 0, y: 0.9, w: 1, h: 0.1 }], include: [] };
    const both = presetFrom(p, 'osd + faint');
    const zonesOnly = presetFrom(p, 'osd', { settings: false });
    const settingsOnly = presetFrom(p, 'faint', { zones: false });
    ok('a preset can hold settings and zones', both.values.threshold === 14 && both.zones.length === 1 && Array.isArray(both.include));
    ok('… zones only (applying it leaves settings alone)', !zonesOnly.values && Object.keys(changesOf(zonesOnly).values).length === 0 && changesOf(zonesOnly).zones.length === 1);
    ok('… settings only (applying it leaves zones alone)', !settingsOnly.zones && !('zones' in changesOf(settingsOnly)));
    ok('neither: no preset', presetFrom(p, 'x', { settings: false, zones: false }) === null);
    ok('description', describe(both) === 'settings + 1 exclude zone' && describe(zonesOnly) === '1 exclude zone', [describe(both), describe(zonesOnly)]);
    let list = upsert(upsert([], both), zonesOnly);
    list = upsert(list, { ...settingsOnly, name: 'OSD' });
    ok('same name (any case) replaces', list.length === 2 && !find(list, 'osd').zones);
    ok('remove by name', remove(list, 'OSD').length === 1);
    ok('bad values are dropped', JSON.stringify(normalizePreset({ name: 'x', values: { threshold: 'abc', stride: 3, bogus: 1 } }).values) === '{"stride":3}');
    const r = fromFile(JSON.parse(JSON.stringify(toFile(list))), []);
    ok('export / import round trip', r.added === 2 && r.list.length === 2);
    ok('import of a non-preset file adds nothing', fromFile({ hello: 1 }, list).added === 0);
}

// --- browser ---
const clip = frameNumberClip({ fps: 25, seconds: 4 });
// another "site": a server on its own port, with or without CORS permission
const serve = cors => http.createServer((req, res) => {
    const size = fs.statSync(clip).size;
    const headers = { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', ...(cors ? { 'Access-Control-Allow-Origin': '*' } : {}) };
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (m) {
        const start = m[1] ? Number(m[1]) : size - Number(m[2]), end = m[1] && m[2] ? Number(m[2]) : size - 1;
        res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
        fs.createReadStream(clip, { start, end }).pipe(res);
        return;
    }
    res.writeHead(200, { ...headers, 'Content-Length': size });
    fs.createReadStream(clip).pipe(res);
});
const withCors = serve(true), noCors = serve(false);
await Promise.all([withCors, noCors].map(s => new Promise(r => s.listen(0, '127.0.0.1', r))));
const other = (s, name = 'clip.mp4') => `http://127.0.0.1:${s.address().port}/${name}`;

const browser = await launch();
try {
    const { page, errors } = await openApp(browser, { hash: 'mode=everyFrame' });
    const openUrl = async url => {
        await page.fill('#srcUrl', url);
        await page.click('#urlForm button[type=submit]');
    };
    const same = new URL(`tests/.cache/${path.basename(clip)}`, page.url()).href;
    await openUrl(same);
    await page.waitForFunction(() => __ph.results.length >= 1, null, { timeout: 30000 });
    ok('same-site URL: frames processed', (await page.evaluate(readFrameNumber)) >= 0 && !(await page.isVisible('#banner')), await page.textContent('#srcLabel'));
    await page.click('#step');
    await page.waitForTimeout(300);
    ok('… step works (seekable file)', (await page.evaluate(readFrameNumber)) >= 1);

    await openUrl(other(withCors));
    await page.waitForFunction(() => /^clip\.mp4 · 320×240/.test(document.getElementById('srcLabel').textContent) && __ph.results.length >= 1 && !document.getElementById('step').disabled, null, { timeout: 30000 });
    await page.click('#step');
    await page.waitForTimeout(300);
    ok('another site that allows reading (CORS): frames read', !(await page.isVisible('#banner')) && (await page.evaluate(readFrameNumber)) >= 1,
        { label: await page.textContent('#srcLabel'), banner: await page.isVisible('#banner') && await page.textContent('#banner'), n: await page.evaluate(readFrameNumber), shown: await page.evaluate(() => __ph.shown) });

    await openUrl(other(noCors));
    await page.waitForSelector('#banner:not([hidden])', { timeout: 30000 });
    ok('another site without CORS: a clear message, no crash', /other sites|CORS/.test(await page.textContent('#banner')), await page.textContent('#banner'));

    await openUrl('https://www.youtube.com/watch?v=abc');
    await page.waitForFunction(() => /player/.test(document.getElementById('banner').textContent));
    ok('a YouTube page link: explained', true);
    ok('the last URL is remembered', (await page.evaluate(() => localStorage.getItem('pixelhunter.url.v1'))) === 'https://www.youtube.com/watch?v=abc');
    ok('no page errors', errors.length === 0, errors);
    await page.close();

    {
        const { page: p, errors: e2 } = await openApp(browser, { hash: `mode=everyFrame&src=${encodeURIComponent(other(withCors, 'clip.mp4?a=1&b=2'))}` });
        await p.waitForFunction(() => __ph.results.length >= 1, null, { timeout: 30000 });
        ok('#src= opens the URL at once (a query with & and = survives)', (await p.inputValue('#srcUrl')).endsWith('clip.mp4?a=1&b=2'));
        ok('no page errors (#src)', e2.length === 0, e2);
        await p.close();
    }

    // user presets in the app
    {
        // a context of its own, so a second page can share its saved presets
        const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
        const p = await ctx.newPage();
        const e3 = [];
        p.on('pageerror', e => e3.push(e.message));
        await p.goto(BASE_URL);
        await p.waitForFunction(() => window.__ph && window.__ph.ready, null, { timeout: 90000 });
        await p.evaluate(() => { __ph.applyPreset('highest'); __ph.setZones('exclude', [{ x: 0, y: 0.9, w: 1, h: 0.1 }]); __ph.setZones('include', [{ x: 0.1, y: 0.1, w: 0.5, h: 0.5 }]); });
        ok('Save is off until there is a name', await p.isDisabled('#savePreset'));
        await p.fill('#presetName', 'Sky, faint');
        await p.click('#savePreset');
        ok('saved with settings and zones', /settings \+ 1 include, 1 exclude zones/.test(await p.textContent('#userPresetInfo')), await p.textContent('#userPresetInfo'));
        await p.fill('#presetName', 'OSD only');
        await p.uncheck('#saveSettings');
        await p.click('#savePreset');
        await p.check('#saveSettings');
        // change everything, then apply each
        await p.evaluate(() => { __ph.applyPreset('low'); __ph.setZones('exclude', []); __ph.setZones('include', []); });
        await p.selectOption('#userPreset', 'Sky, faint');
        await p.click('#applyUserPreset');
        const a = await p.evaluate(() => ({ t: __ph.params.sigmas, s: __ph.params.confirmN, z: __ph.params.zones.length, i: __ph.params.include.length }));
        ok('applying restores settings and both kinds of zones', a.t === 6 && a.s === 4 && a.z === 1 && a.i === 1, a);
        ok('… and the controls show them', (await p.inputValue('#param-sigmas')) === '6' && (await p.getAttribute('#preset-highest', 'aria-pressed')) === 'true');
        await p.evaluate(() => { __ph.applyPreset('low'); __ph.setZones('exclude', []); });
        await p.selectOption('#userPreset', 'OSD only');
        await p.click('#applyUserPreset');
        const b = await p.evaluate(() => ({ t: __ph.params.threshold, z: __ph.params.zones.length }));
        ok('a zones-only preset sets the zones and leaves the settings', b.t === 35 && b.z === 1, b);
        await p.reload();
        await p.waitForFunction(() => __ph.ready);
        ok('presets are remembered', (await p.evaluate(() => __ph.userPresets.map(x => x.name))).join() === 'Sky, faint,OSD only');
        const [dl] = await Promise.all([p.waitForEvent('download'), p.click('#exportPresets')]);
        const file = path.join(CACHE, 'presets-export.json');
        await dl.saveAs(file);
        await p.selectOption('#userPreset', 'OSD only');
        await p.click('#deleteUserPreset');
        ok('delete asks for a second click', (await p.evaluate(() => __ph.userPresets.length)) === 2 && (await p.textContent('#deleteUserPreset')) === 'Delete?');
        await p.click('#deleteUserPreset');
        ok('… then deletes', (await p.evaluate(() => __ph.userPresets.map(x => x.name))).join() === 'Sky, faint');
        await p.setInputFiles('#presetFile', file);
        await p.waitForFunction(() => __ph.userPresets.length === 2);
        ok('import brings it back', /Imported 2/.test(await p.textContent('#userPresetInfo')));
        ok('no page errors (presets)', e3.length === 0, e3);
        // same browser (same saved presets), current settings changed first
        await p.evaluate(() => { __ph.applyPreset('low'); __ph.setZones('include', []); });
        const q = await p.context().newPage();
        await q.goto(`${p.url().split('#')[0]}#preset=sky,%20faint`);
        await q.waitForFunction(() => window.__ph && window.__ph.ready);
        const c = await q.evaluate(() => ({ t: __ph.params.sigmas, i: __ph.params.include.length }));
        ok('#preset=<my preset name> applies it on opening', c.t === 6 && c.i === 1, c);
        await ctx.close();
    }
} finally {
    await browser.close();
    withCors.close();
    noCors.close();
}
