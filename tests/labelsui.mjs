// Labels in the app: Real / Not an object (apart from Keep tracking), labels kept per clip
// (browser storage, and a data folder: here the origin-private file system standing in for
// the folder picker), objects on a labelled path re-found with their label after a reload,
// Mark missed (snapping, extending, undo), bookmarks in the labels, old bookmarks moved in,
// crops, export / import, a renamed file finding its labels.
import fs from 'fs';
import path from 'path';
import { launch, ok, openApp, showTab } from './lib/env.mjs';
import { sceneClip, CACHE } from './lib/clips.mjs';
import { interpolate } from '../src/labels.js';

const dot = (size, contrast, fx, fy, vx, vy, extra = {}) => ({ size, contrast, fx, fy, vx, vy, ...extra });
const scene = { width: 640, height: 360, frames: 90, camera: 'pan', seed: 31, noise: 2,
    targets: [dot(3, 60, 120, 100, 6 + 1.5, 2.5 + 0.8), dot(3, -50, 450, 260, 6 - 1.2, 2.5 - 0.6)] };
const clip = await sceneClip(scene);
const copy = path.join(CACHE, 'labels-renamed-copy.mp4');
fs.copyFileSync(clip.path, copy);
const NAME = path.basename(clip.path);

// in the page: the screen position of a frame point (processing px) on the display canvas
const screenOf = ([x, y]) => {
    const c = document.getElementById('display').getBoundingClientRect(), g = __ph.pipeline.geometry;
    const s = Math.min(c.width / g.w, c.height / g.h);
    return [c.left + (c.width - g.w * s) / 2 + (x + 0.5) * s, c.top + (c.height - g.h * s) / 2 + (y + 0.5) * s];
};
const objects = page => page.evaluate(() => __ph.objectsView.summary());
const labelSet = page => page.evaluate(() => __ph.labels.set && JSON.parse(JSON.stringify(__ph.labels.set)));
async function open(page, file) {
    await page.setInputFiles('#file', file);
    await page.waitForFunction(() => __ph.labels.set && __ph.results.length >= 1, null, { timeout: 30000 });
}
async function playUntil(page, cond, arg, ms = 60000) {
    await page.click('#play');
    await page.waitForFunction(cond, arg, { timeout: ms });
    await page.click('#play');
    await page.waitForFunction(() => !__ph.loop.playing);
}

const browser = await launch();
try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
    const { page, errors } = await openApp({ newPage: () => context.newPage() }, { hash: 'mode=everyFrame' });
    page.on('crash', () => console.log('page crashed'));
    page.on('console', m => { if (m.type() === 'error') console.log('console error:', m.text()); });
    ok('no labels before a clip', (await page.textContent('#labelsStatus')).includes('Open a video') && await page.isDisabled('#markMissed'));
    // bookmarks kept by file name before labels existed
    await page.evaluate(n => localStorage.setItem('pixelhunter.bookmarks.v1', JSON.stringify({ [n]: [{ frame: 7, time: 0.28 }] })), NAME);

    await open(page, clip.path);
    let set = await labelSet(page);
    ok('a clip gets labels: its id, name, size', /^[0-9a-f]{64}$/.test(set.clip.id) && set.clip.name === NAME && set.clip.width === 640 && set.objects.length === 0, set.clip);
    await page.waitForFunction(() => !__ph.labels.dirty);
    ok('old bookmarks moved into the clip\'s labels (and out of the old place)', (await labelSet(page)).bookmarks.some(b => b.frame === 7)
        && await page.evaluate(() => localStorage.getItem('pixelhunter.bookmarks.v1') === null) && (await page.locator('#tlMarks button').count()) === 1);
    ok('kept in this browser (no folder picked); the folder picker is offered', (await page.textContent('#labelsStatus')).includes('in this browser') && await page.isVisible('#labelsPick'));

    await playUntil(page, () => __ph.objectsView.summary().length >= 2);
    const objs = await objects(page);
    const [a, b] = objs;
    // Real: a label, not pinned
    await page.evaluate(id => __ph.objectsView.inspect(id), a.id);
    await page.click('#inspReal');
    set = await labelSet(page);
    const la = set.objects[0];
    ok('✓ Real labels it: a label with its path, size and crops', set.objects.length === 1 && la.label === 'real' && la.keys.length >= 2 && la.crops.length >= 1, la);
    ok('… not pinned (Keep tracking stays off)', (await page.getAttribute('#inspPin', 'aria-pressed')) === 'false' && (await page.getAttribute('#inspReal', 'aria-pressed')) === 'true');
    ok('… shown in the list and counted', (await page.textContent(`#objectList li[data-oid="${a.id}"] .oid`)).includes('✓') && (await page.textContent('#labelCounts')).includes('1 real'));
    await page.evaluate(id => __ph.objectsView.inspect(id), b.id);
    await page.click('#inspNot');
    set = await labelSet(page);
    ok('Not an object: a "not" label', set.objects.length === 2 && set.objects.some(o => o.label === 'not'));
    // the path grows while it is tracked
    const keysBefore = set.objects.find(o => o.label === 'real').keys;
    await playUntil(page, () => __ph.lastResult && __ph.lastResult.frame >= 70);
    await page.evaluate(() => __ph.labels.flush());
    set = await labelSet(page);
    const grown = set.objects.find(o => o.label === 'real').keys;
    ok('a labelled object\'s path grows as it is tracked (kept as keyframes)', grown[grown.length - 1][0] > keysBefore[keysBefore.length - 1][0] && grown.length < 30, { before: keysBefore.length, after: grown.length });

    // mark missed: snapped to a candidate near the click, extended by a second click, undo
    await page.click('#back');
    await page.waitForTimeout(300);
    await page.waitForFunction(() => !__ph.navigating && __ph.lastResult);
    await page.keyboard.press('m');
    ok('M: mark mode', (await page.getAttribute('#markMissed', 'aria-pressed')) === 'true' && await page.evaluate(() => document.getElementById('stage').classList.contains('marking')));
    const cand = await page.evaluate(() => { const r = __ph.lastResult; const c = r.candidates[0] || null; return c && { cx: c.cx, cy: c.cy, w: c.w, h: c.h, t: r.time, s: r.scale }; });
    let [sx, sy] = await page.evaluate(screenOf, [cand.cx + 2, cand.cy + 1]);
    await page.mouse.click(sx, sy);
    set = await labelSet(page);
    const markedId = await page.evaluate(() => __ph.labels.markId);
    // (a point on the line through its neighbours is not kept as a keyframe: compared on the path)
    const marked = set.objects.find(o => o.id === markedId);
    const at = marked && interpolate(marked.keys, cand.t);
    ok('a click snaps to the candidate next to it (position and size)', !!at && Math.hypot(at[0] - cand.cx, at[1] - cand.cy) < 1.01 && Math.abs(at[2] - cand.w) <= 1 && Math.abs(at[3] - cand.h) <= 1, { cand, at });
    // somewhere with nothing: a new marked object with the default size
    await page.click('#markNew');
    [sx, sy] = await page.evaluate(screenOf, [300, 40]);
    await page.mouse.click(sx, sy);
    const f0 = await page.evaluate(() => __ph.shown.frame);
    await page.click('#step');
    await page.waitForFunction(f => !__ph.navigating && __ph.shown.frame === f + 1, f0);
    [sx, sy] = await page.evaluate(screenOf, [304, 42]);
    await page.mouse.click(sx, sy);
    set = await labelSet(page);
    const m = set.objects.find(o => o.source === 'marked' && o.keys.every(k => k[1] > 290 && k[1] < 310));
    ok('New object, two clicks a frame apart: one marked path of two points, 4×4 px', !!m && m.keys.length === 2 && m.keys[0][3] === 4 && m.label === 'real', m);
    await page.click('#markUndo');
    set = await labelSet(page);
    ok('Undo point removes the last one', set.objects.find(o => o.id === m.id).keys.length === 1);
    ok('marked labels drawn on the video while marking (cyan)', await page.evaluate(() => {
        const c = document.getElementById('overlay'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        for (let i = 0; i < d.length; i += 4) if (d[i] < 120 && d[i + 1] > 180 && d[i + 2] > 220 && d[i + 3] > 100) return true;
        return false;
    }));
    await page.keyboard.press('Escape');
    ok('Esc stops marking', (await page.getAttribute('#markMissed', 'aria-pressed')) === 'false');
    await page.keyboard.press('b');
    await page.check('#labelsComplete');
    await page.evaluate(() => __ph.labels.flush());
    set = await labelSet(page);
    ok('bookmarks and "all real objects labelled" kept in the labels', set.bookmarks.length === 2 && set.complete === true);
    const nLabels = set.objects.length;
    ok('status: not backed up yet', /\d+ not backed up/.test(await page.textContent('#labelsStatus')), await page.textContent('#labelsStatus'));

    // export: one file with the crops
    await showTab(page, 'settings');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#exportLabels')]);
    const exported = JSON.parse(fs.readFileSync(await dl.path(), 'utf8'));
    ok('Export: the labels file with its crops (PNG)', dl.suggestedFilename().endsWith(`.${set.clip.id.slice(0, 8)}.labels.json`) && exported.objects.length === nLabels
        && Object.values(exported.crops || {}).length >= 1 && Object.values(exported.crops).every(u => u.startsWith('data:image/png;base64,')), dl.suggestedFilename());
    ok('… then nothing is "not backed up"', !(await page.textContent('#labelsStatus')).includes('not backed up'), await page.textContent('#labelsStatus'));
    const crop = await page.evaluate(async url => { const bm = await createImageBitmap(await (await fetch(url)).blob()); return [bm.width, bm.height]; }, Object.values(exported.crops)[0]);
    ok('… crops are 32×32', crop[0] === 32 && crop[1] === 32, crop);

    await showTab(page, 'objects');
    // reload: labels back from browser storage; objects on a labelled path show the label
    await page.reload();
    await page.waitForFunction(() => window.__ph && __ph.ready);
    await open(page, clip.path);
    set = await labelSet(page);
    ok('after a reload the clip\'s labels are back', set.objects.length === nLabels && set.complete === true && set.bookmarks.length === 2, { n: set.objects.length, nLabels, complete: set.complete, bookmarks: set.bookmarks });
    await playUntil(page, () => __ph.objectsView.summary().some(o => o.label === 'real') && __ph.objectsView.summary().some(o => o.label === 'not'));
    const again = await objects(page);
    ok('objects found again on a labelled path get its label (and the "not" one is hidden)', again.some(o => o.label === 'real' && o.labelId) && again.some(o => o.label === 'not' && o.labelId)
        && !(await page.evaluate(() => [...document.querySelectorAll('#objectList li')].map(li => li.dataset.oid))).includes(String(again.find(o => o.label === 'not').id)), again);
    ok('… and no card for the known false alarm', (await page.locator(`#cards .card[data-oid="${again.find(o => o.label === 'not').id}"]`).count()) === 0);
    ok('labels drawn on the video (green box)', await page.evaluate(() => {
        const c = document.getElementById('overlay'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        for (let i = 0; i < d.length; i += 4) if (d[i] > 50 && d[i] < 100 && d[i + 1] > 170 && d[i + 2] > 110 && d[i + 2] < 160 && d[i + 3] > 100) return true;
        return false;
    }));

    // a data folder (the origin-private file system stands in for the picker)
    await page.evaluate(() => { window.showDirectoryPicker = async () => navigator.storage.getDirectory(); });
    await page.click('#labelsPick');
    await page.waitForFunction(() => document.getElementById('labelsStatus').textContent.includes('data folder'), null, { timeout: 10000 });
    const files = await page.evaluate(async () => {
        const root = await navigator.storage.getDirectory(), list = [];
        const walk = async (dir, pre) => { for await (const [n, h] of dir.entries()) { if (h.kind === 'directory') await walk(h, `${pre}${n}/`); else list.push(`${pre}${n}`); } };
        await walk(root, '');
        return list;
    });
    const id8 = set.clip.id.slice(0, 8);
    ok('Pick a folder: the labels file and crops written there', files.includes(`labels/${NAME.replace(/\.mp4$/, '')}.${id8}.labels.json`) && files.some(f => f.startsWith(`crops/${id8}/`) && f.endsWith('.png')), files);
    ok('… and the browser copy dropped', (await page.evaluate(() => __ph.labels.store.browserClips())).length === 0);

    // a renamed copy of the file finds the same labels (in the folder)
    // (a folder picked on disk is remembered and allowed again with one click on the next visit;
    // the stand-in here isn't remembered, so it is picked again after the reload)
    await page.reload();
    await page.waitForFunction(() => window.__ph && __ph.ready);
    await page.evaluate(() => { window.showDirectoryPicker = async () => navigator.storage.getDirectory(); });
    await showTab(page, 'settings');
    await page.click('#pickFolder');
    await page.waitForFunction(() => __ph.labels.store.access === 'granted', null, { timeout: 5000 });
    await showTab(page, 'objects');
    await open(page, copy);
    set = await labelSet(page);
    ok('a renamed copy finds its labels in the folder', set.objects.length === nLabels && set.clip.name === 'labels-renamed-copy.mp4', set.clip.name);
    await page.evaluate(() => __ph.labels.flush());
    const files2 = await page.evaluate(async () => { const d = await (await navigator.storage.getDirectory()).getDirectoryHandle('labels'); const l = []; for await (const [n] of d.entries()) l.push(n); return l; });
    ok('… saved under its new name (the old file replaced)', files2.length === 1 && files2[0].startsWith('labels-renamed-copy.'), files2);

    // import into an empty browser
    const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const { page: p2, errors: e2 } = await openApp({ newPage: () => ctx2.newPage() });
    await open(p2, clip.path);
    ok('another browser: no labels', (await labelSet(p2)).objects.length === 0);
    await p2.setInputFiles('#labelsFile', { name: 'l.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(exported)) });
    await p2.waitForFunction(() => document.getElementById('browserData').textContent.startsWith('Imported'), null, { timeout: 10000 });
    ok('Import into another browser: the labels', (await labelSet(p2)).objects.length === nLabels);
    const crop2 = await p2.evaluate(async name => { const b = await __ph.labels.store.loadCrop(__ph.labels.set.clip, name); return b ? b.size : 0; }, exported.objects.find(o => o.crops.length).crops[0]);
    ok('… and their crops', crop2 > 50, crop2);
    const bad = await p2.evaluate(() => __ph.labels.importFiles([new File(['{"kind":"presets"}'], 'x.json')]));
    ok('… a file that isn\'t labels is refused', bad.imported === 0 && bad.bad === 1);
    ok('no page errors', errors.length === 0 && e2.length === 0, [...errors, ...e2]);
    await ctx2.close();
} finally {
    await browser.close();
}
