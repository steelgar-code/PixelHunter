// Detection-area zones: zones.js (Node); exclusion zones on synthetic scenes (an OSD overlay
// fixed on screen); inclusion zones (cropped detection: same results inside, less time);
// drawing zones in the app, the hash and the export.
import { launch, ok, openApp, loadScene } from './lib/env.mjs';
import { instrumentMats } from './lib/mats.mjs';
import { SCENES } from '../src/scenes.js';
import { normalizeZone, parseZones, formatZones, zoneRect, inZones, loadZones, saveZones, regionRects, ZONES_KEY, INCLUDE_KEY } from '../src/zones.js';

// --- zones.js ---
ok('a zone dragged right-to-left is flipped and clipped to the frame',
    JSON.stringify(normalizeZone({ x: 0.5, y: 1.1, w: -0.7, h: -0.3 })) === JSON.stringify({ x: 0, y: 0.8, w: 0.5, h: 0.2 }));
ok('a click without a drag is no zone', normalizeZone({ x: 0.3, y: 0.3, w: 0.001, h: 0.2 }) === null);
ok('text round trip, bad entries skipped', formatZones(parseZones('0.1,0.2,0.3,0.4; x,1 ;0.9,0.9,0.5,0.5')) === '0.1,0.2,0.3,0.4;0.9,0.9,0.1,0.1');
ok('pixel rectangle covers every pixel the zone touches', JSON.stringify(zoneRect({ x: 0.1, y: 0.25, w: 0.2, h: 0.5 }, 100, 10)) === JSON.stringify({ x0: 10, y0: 2, x1: 30, y1: 8 }));
ok('inside / outside a zone (pixel centres), with padding', inZones([{ x: 0.1, y: 0, w: 0.2, h: 1 }], 10, 5, 100, 10)
    && inZones([{ x: 0.1, y: 0, w: 0.2, h: 1 }], 29, 5, 100, 10) && !inZones([{ x: 0.1, y: 0, w: 0.2, h: 1 }], 30, 5, 100, 10)
    && inZones([{ x: 0.1, y: 0, w: 0.2, h: 1 }], 31, 5, 100, 10, 2));
ok('no inclusion zones: the whole frame', regionRects([], 100, 100) === null);
ok('inclusion regions are padded and clipped', JSON.stringify(regionRects([{ x: 0, y: 0.5, w: 0.2, h: 0.2 }], 100, 100, 4)) === JSON.stringify([{ x: 0, y: 46, w: 24, h: 28 }]));
ok('overlapping regions merge, distant ones stay apart', regionRects([{ x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, { x: 0.28, y: 0.2, w: 0.1, h: 0.1 }, { x: 0.7, y: 0.7, w: 0.1, h: 0.1 }], 100, 100, 2).length === 2);
ok('a chain of overlaps merges into one', regionRects([{ x: 0, y: 0, w: 0.2, h: 0.1 }, { x: 0.4, y: 0, w: 0.2, h: 0.1 }, { x: 0.15, y: 0, w: 0.3, h: 0.1 }], 100, 100).length === 1);
{
    const mem = new Map();
    const storage = { getItem: k => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
    saveZones(storage, [{ x: 0.1, y: 0.1, w: 0.2, h: 0.2 }]);
    ok('save / load round trip', loadZones(storage).length === 1);
    mem.set(ZONES_KEY, '{broken');
    ok('broken storage: no zones', loadZones(storage).length === 0);
}

// --- in the browser ---
const browser = await launch();
try {
    const { page, errors } = await openApp(browser);
    await page.evaluate(instrumentMats);
    await page.evaluate(async () => {
        const { createScene, greyToRgba } = await import('/src/synth.js');
        const { createPipeline } = await import('/src/pipeline.js');
        const { createScore } = await import('/src/score.js');
        const { inZones } = await import('/src/zones.js');
        // returns raw and confirmed scores; candidates inside / outside the zones, ego-motion fits
        window.runZones = (sceneOpts, params = {}, countIn = params.zones || []) => {
            const s = createScene(sceneOpts);
            const pipe = createPipeline(cv, { ...window.__ph.params, ...params });
            const zones = countIn;
            const raw = createScore({ fps: s.fps }), conf = createScore({ fps: s.fps });
            let inside = 0, fitted = 0, frames = 0, err = 0;
            for (let k = 0; k < s.frames; k++) {
                const f = s.frame(k);
                const r = pipe.push({ imageData: new ImageData(greyToRgba(f.grey), s.width, s.height), width: s.width, height: s.height,
                    time: k / s.fps, frame: k, seq: k, gap: 0, jump: k === 0, truth: f.truth }).result;
                if (!r) continue;
                frames++;
                const e = r.egoPrev;
                if (e && e.ok && r.truth.H) {
                    fitted++;
                    // worst corner error of the fitted H against the true one (px)
                    const pr = (H, x, y) => { const d = H[6] * x + H[7] * y + H[8]; return [(H[0] * x + H[1] * y + H[2]) / d, (H[3] * x + H[4] * y + H[5]) / d]; };
                    for (const [x, y] of [[0, 0], [s.width - 1, 0], [0, s.height - 1], [s.width - 1, s.height - 1]]) {
                        const a = pr(e.Hfull, x, y), b = pr(r.truth.H, x, y);
                        err = Math.max(err, Math.hypot(a[0] - b[0], a[1] - b[1]));
                    }
                }
                if (!r.detect.ok) continue;
                const targets = r.truth.targets.filter(t => !inZones(zones, t.cx, t.cy, s.width, s.height));
                raw.add(r.frame, r.candidates, targets);
                conf.add(r.frame, r.confirmed.map(t => t.box), targets);
                inside += r.candidates.filter(c => inZones(zones, c.cx, c.cy, s.width, s.height)).length;
            }
            pipe.dispose();
            const sum = o => ({ hit: o.hitRate === null ? null : +o.hitRate.toFixed(3), fpPerFrame: +o.fpPerFrame.toFixed(3), fpPer10s: +o.fpPer10s.toFixed(2) });
            return { raw: sum(raw.summary()), conf: sum(conf.summary()), inside, fitted, frames, err: +err.toFixed(2) };
        };
    });
    await page.evaluate(async () => {
        const { createScene, greyToRgba } = await import('/src/synth.js');
        const { createPipeline } = await import('/src/pipeline.js');
        // per-frame candidates (rounded centres), median detect time, processed area, views
        window.runCrop = (sceneOpts, params = {}) => {
            const s = createScene(sceneOpts);
            const pipe = createPipeline(cv, { ...window.__ph.params, ...params });
            const frames = {}, ms = [];
            let area = null, maskOutside = 0;
            for (let k = 0; k < s.frames; k++) {
                const f = s.frame(k);
                const out = pipe.push({ imageData: new ImageData(greyToRgba(f.grey), s.width, s.height), width: s.width, height: s.height,
                    time: k / s.fps, frame: k, seq: k, gap: 0, jump: k === 0, truth: f.truth });
                const r = out.result;
                if (!r || !r.detect.ok) continue;
                frames[r.frame] = r.candidates.map(c => [+c.cx.toFixed(2), +c.cy.toFixed(2), c.area, c.x, c.y, c.w, c.h]);
                ms.push(r.timings.detect);
                area = r.detect.processedArea;
                if (k === s.frames - 1 && params.include && params.include.length) {
                    // the mask view is full-frame and empty outside the regions
                    const c = document.createElement('canvas');
                    c.width = s.width; c.height = s.height;
                    pipe.renderView('mask', out, c.getContext('2d'));
                    const d = c.getContext('2d').getImageData(0, 0, s.width, s.height).data;
                    const reg = r.detect.regions;
                    for (let y = 0; y < s.height; y++) for (let x = 0; x < s.width; x++) {
                        if (reg.some(q => x >= q.x && x < q.x + q.w && y >= q.y && y < q.y + q.h)) continue;
                        if (d[(y * s.width + x) * 4]) maskOutside++;
                    }
                }
            }
            pipe.dispose();
            ms.sort((a, b) => a - b);
            return { frames, ms: +ms[ms.length >> 1].toFixed(1), area, maskOutside };
        };
    });
    const runCrop = (scene, params) => page.evaluate(([s, p]) => window.runCrop(s, p), [scene, params]);
    const run = (scene, params, countIn) => page.evaluate(([s, p, c]) => window.runZones(s, p, c), [scene, params, countIn]);

    const osd = SCENES.osd;
    const off = await run({ ...osd.options, frames: 80 }, { zones: [] }, osd.zones);
    const on = await run({ ...osd.options, frames: 80 }, { zones: osd.zones });
    console.log('OSD scene, 80 frames:', JSON.stringify({ off, on }));
    ok('OSD without zones: the overlay gives false positives', off.raw.fpPerFrame > 1 && off.inside > 0, off);
    ok('OSD with zones: no candidate inside a zone', on.inside === 0, on);
    // (the adaptive detector leaves a little scattered noise before confirmation; none is confirmed)
    ok('OSD with zones: the overlay\'s false positives gone (< 0.15 raw per frame, none confirmed)', on.raw.fpPerFrame < 0.15 && on.conf.fpPer10s === 0, { raw: on.raw, conf: on.conf });
    ok('OSD with zones: targets outside the zones still found (hit ≥ 95 %)', on.raw.hit >= 0.95 && on.conf.hit >= 0.9, on);
    ok('OSD with zones: camera motion fitted on every frame, worst corner error < 1 px', on.fitted === on.frames - 1 && on.err < 1, on);

    // a zone over a target's path: the target isn't detected while inside it
    {
        const scene = { width: 640, height: 360, frames: 40, camera: 'pan', seed: 61, noise: 2,
            targets: [{ size: 4, contrast: 60, fx: 150, fy: 100, vx: 6 + 2, vy: 2.5 + 1 }, { size: 4, contrast: 60, fx: 400, fy: 250, vx: 6 - 2, vy: 2.5 }] };
        const zone = [{ x: 0.15, y: 0.15, w: 0.3, h: 0.3 }];
        const r = await run(scene, { zones: zone });
        const base = await run(scene, { zones: [] }, zone);
        ok('a mover inside a zone gives no candidates there', r.inside === 0 && base.inside > 0, { with: r.inside, without: base.inside });
        ok('… the mover outside it is still found every frame', r.raw.hit >= 0.95, r.raw);
    }
    // zones on a scene without overlays change nothing outside them
    {
        const r = await run({ ...SCENES['pan-dots'].options, frames: 60 }, { zones: [{ x: 0.9, y: 0, w: 0.1, h: 0.1 }] });
        ok('pan-dots with a corner zone: still ≥ 95 % hit, no false positives', r.raw.hit >= 0.95 && r.raw.fpPerFrame < 0.05, r.raw);
    }

    // inclusion zones: cropped detection gives the full-frame result inside the zone
    {
        const scene = { width: 1280, height: 720, frames: 40, camera: 'drone', seed: 81, noise: 2, shapes: 40,
            targets: [{ size: 3, contrast: 50, fx: 300, fy: 250, vx: 4 + 2, vy: -1.5 + 1 }, { size: 3, contrast: -50, fx: 900, fy: 500, vx: 4 - 1.5, vy: -1.5 }] };
        const inc = [{ x: 0.15, y: 0.2, w: 0.3, h: 0.35 }];
        for (const detectMode of ['robust', 'basic']) {
            const full = await runCrop(scene, { detectMode, include: [] });
            const crop = await runCrop(scene, { detectMode, include: inc });
            const W = scene.width, H = scene.height, z = inc[0];
            // blobs wholly inside the zone (3 px clear of its edges; a blob across an edge is clipped): the same
            const inner = c => c[3] >= z.x * W + 3 && c[3] + c[5] <= (z.x + z.w) * W - 3 && c[4] >= z.y * H + 3 && c[4] + c[6] <= (z.y + z.h) * H - 3;
            let same = 0, differ = [], outside = 0, insideCount = 0;
            for (const k of Object.keys(full.frames)) {
                const a = JSON.stringify(full.frames[k].filter(inner)), b = JSON.stringify((crop.frames[k] || []).filter(inner));
                if (a === b) same++; else differ.push(k);
                outside += (crop.frames[k] || []).filter(c => !inZones(inc, c[0], c[1], W, H)).length;
                insideCount += full.frames[k].filter(inner).length;
            }
            ok(`${detectMode}: inside an inclusion zone, the same candidates as the full frame`, differ.length === 0 && insideCount > 0, { same, differ: differ.slice(0, 5), insideCount });
            ok(`${detectMode}: no candidate outside the inclusion zone`, outside === 0, outside);
            ok(`${detectMode}: a zone of ${Math.round(crop.area * 100)} % of the frame is processed in less than half the time`, crop.ms < full.ms / 2, { full: full.ms, crop: crop.ms, area: crop.area });
            ok(`${detectMode}: mask view empty outside the processed regions`, crop.maskOutside === 0, crop.maskOutside);
        }
        // two zones far apart, with an exclusion zone inside one of them
        const two = await runCrop(scene, { include: [{ x: 0.15, y: 0.2, w: 0.3, h: 0.35 }, { x: 0.6, y: 0.55, w: 0.25, h: 0.3 }], zones: [{ x: 0.15, y: 0.2, w: 0.1, h: 0.1 }] });
        const all = Object.values(two.frames).flat();
        ok('two inclusion zones: candidates in both, none in the exclusion zone inside one', all.some(c => c[0] < 640) && all.some(c => c[0] > 640)
            && !all.some(c => inZones([{ x: 0.15, y: 0.2, w: 0.1, h: 0.1 }], c[0], c[1], 1280, 720)), { n: all.length });
    }
    ok('no Mats left behind', (await page.evaluate(() => window.__liveMats())) === 0);
    ok('no page errors', errors.length === 0, errors);
    await page.close();

    // the app: zones from the hash, drawn with the mouse, removed, exported
    {
        {
            const { page: q } = await openApp(browser, { hash: 'include=0.1,0.1,0.5,0.5;0.7,0.7,0.2,0.2' });
            ok('inclusion zones from the hash', (await q.evaluate(() => __ph.params.include.length)) === 2);
            await q.close();
        }
        const { page: p, errors: e2 } = await openApp(browser, { hash: 'mode=everyFrame&exclude=0.0125,0.018519,0.195833,0.066667' });
        ok('zones from the hash', (await p.evaluate(() => __ph.params.zones.length)) === 1);
        await loadScene(p, 'osd');
        await p.waitForFunction(() => __ph.results.length >= 1, null, { timeout: 30000 });
        ok('zone list shows source pixels', (await p.textContent('#zoneList')).includes('12,10 188×36 px'), await p.textContent('#zoneList'));
        await p.click('#tab-settings');
        await p.click('#drawZone');
        const box = await p.evaluate(() => {
            const r = document.getElementById('display').getBoundingClientRect();
            const s = Math.min(r.width / 960, r.height / 540), ox = (r.width - 960 * s) / 2, oy = (r.height - 540 * s) / 2;
            return { x: r.left + ox, y: r.top + oy, s };
        });
        // drag from (0, 490) to (960, 540) in frame px: the bottom bar
        await p.mouse.move(box.x + 0 * box.s + 1, box.y + 494 * box.s);
        await p.mouse.down();
        await p.mouse.move(box.x + 500 * box.s, box.y + 520 * box.s, { steps: 4 });
        await p.mouse.move(box.x + 960 * box.s + 20, box.y + 540 * box.s + 20, { steps: 4 });
        await p.mouse.up();
        const zones = await p.evaluate(() => __ph.params.zones);
        ok('a drag adds a zone, clipped to the frame', zones.length === 2 && zones[1].x < 0.01 && Math.abs(zones[1].y - 494 / 540) < 0.01 && zones[1].x + zones[1].w === 1 && zones[1].y + zones[1].h === 1, zones);
        await p.keyboard.press('Escape');
        ok('Esc leaves draw mode', (await p.getAttribute('#drawZone', 'aria-pressed')) === 'false');
        ok('zones are saved', (await p.evaluate(k => JSON.parse(localStorage.getItem(k)).length, ZONES_KEY)) === 2);
        ok('zone text field mirrors the zones', (await p.inputValue('#zoneText')).split(';').length === 2);
        for (let i = 0; i < 40; i++) await p.click('#step');
        const st = await p.evaluate(() => __ph.stats.score), cs = await p.evaluate(() => __ph.stats.confScore);
        ok('OSD scene in the app with both zones: no confirmed false positives, little raw noise', st && st.fpPerFrame < 0.15 && st.hitRate >= 0.9 && cs.fpPer10s === 0, { raw: st, confirmed: cs });
        await p.click('#tab-stats');
        const [dl] = await Promise.all([p.waitForEvent('download'), p.click('#exportJson')]);
        await p.click('#tab-settings');
        const json = JSON.parse(await (await import('fs')).promises.readFile(await dl.path(), 'utf8'));
        ok('export records the zones in source pixels', json.meta.excludeZones.length === 2 && JSON.stringify(json.meta.excludeZones[0].px) === '[12,10,188,36]' && Array.isArray(json.meta.includeZones), json.meta.excludeZones);
        await p.click('#zoneList li:first-child button');
        ok('× removes a zone', (await p.evaluate(() => __ph.params.zones.length)) === 1);
        await p.fill('#zoneText', '0.1,0.1,0.2,0.2;0.5,0.5,0.1,0.1');
        await p.press('#zoneText', 'Enter');
        await p.locator('#zoneText').blur();
        ok('zones typed as text', (await p.evaluate(() => __ph.params.zones.length)) === 2);
        // an inclusion zone: picked with the kind switch, drawn, shown in the stats
        await p.click('label:has(input[name=zoneKind][value=include])');
        ok('picking a zone kind turns draw mode on', (await p.getAttribute('#drawZone', 'aria-pressed')) === 'true');
        await p.mouse.move(box.x + 100 * box.s, box.y + 100 * box.s);
        await p.mouse.down();
        await p.mouse.move(box.x + 580 * box.s, box.y + 370 * box.s, { steps: 4 });
        await p.mouse.up();
        await p.keyboard.press('Escape');
        const inc = await p.evaluate(() => __ph.params.include);
        ok('a drag in include mode adds an inclusion zone', inc.length === 1 && (await p.textContent('#includeList')).includes('100,100 480×270 px'), inc);
        ok('inclusion zones are saved', (await p.evaluate(k => JSON.parse(localStorage.getItem(k)).length, INCLUDE_KEY)) === 1);
        await p.click('#step');
        await p.waitForTimeout(400);
        ok('stats show the share of the frame processed', /% area\)/.test(await p.textContent('#stDetect')), await p.textContent('#stDetect'));
        await p.click('#clearZones');
        ok('Clear all', (await p.evaluate(() => __ph.params.zones.length + __ph.params.include.length)) === 0);
        ok('no page errors (app)', e2.length === 0, e2);
        await p.close();
    }
} finally {
    await browser.close();
}
