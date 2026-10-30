// Exclusion zones: zones.js (Node), detection and camera motion with zones on synthetic scenes
// (an OSD overlay fixed on screen), drawing zones in the app, the hash and the export.
import { launch, ok, openApp } from './lib/env.mjs';
import { instrumentMats } from './lib/mats.mjs';
import { SCENES } from '../src/scenes.js';
import { normalizeZone, parseZones, formatZones, zoneRect, inZones, loadZones, saveZones, ZONES_KEY } from '../src/zones.js';

// --- zones.js ---
ok('a zone dragged right-to-left is flipped and clipped to the frame',
    JSON.stringify(normalizeZone({ x: 0.5, y: 1.1, w: -0.7, h: -0.3 })) === JSON.stringify({ x: 0, y: 0.8, w: 0.5, h: 0.2 }));
ok('a click without a drag is no zone', normalizeZone({ x: 0.3, y: 0.3, w: 0.001, h: 0.2 }) === null);
ok('text round trip, bad entries skipped', formatZones(parseZones('0.1,0.2,0.3,0.4; x,1 ;0.9,0.9,0.5,0.5')) === '0.1,0.2,0.3,0.4;0.9,0.9,0.1,0.1');
ok('pixel rectangle covers every pixel the zone touches', JSON.stringify(zoneRect({ x: 0.1, y: 0.25, w: 0.2, h: 0.5 }, 100, 10)) === JSON.stringify({ x0: 10, y0: 2, x1: 30, y1: 8 }));
ok('inside / outside a zone (pixel centres), with padding', inZones([{ x: 0.1, y: 0, w: 0.2, h: 1 }], 10, 5, 100, 10)
    && inZones([{ x: 0.1, y: 0, w: 0.2, h: 1 }], 29, 5, 100, 10) && !inZones([{ x: 0.1, y: 0, w: 0.2, h: 1 }], 30, 5, 100, 10)
    && inZones([{ x: 0.1, y: 0, w: 0.2, h: 1 }], 31, 5, 100, 10, 2));
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
    const run = (scene, params, countIn) => page.evaluate(([s, p, c]) => window.runZones(s, p, c), [scene, params, countIn]);

    const osd = SCENES.osd;
    const off = await run({ ...osd.options, frames: 80 }, { zones: [] }, osd.zones);
    const on = await run({ ...osd.options, frames: 80 }, { zones: osd.zones });
    console.log('OSD scene, 80 frames:', JSON.stringify({ off, on }));
    ok('OSD without zones: the overlay gives false positives', off.raw.fpPerFrame > 1 && off.inside > 0, off);
    ok('OSD with zones: no candidate inside a zone', on.inside === 0, on);
    ok('OSD with zones: false positives gone (< 0.05 per frame, none confirmed)', on.raw.fpPerFrame < 0.05 && on.conf.fpPer10s === 0, on.raw);
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
    ok('no Mats left behind', (await page.evaluate(() => window.__liveMats())) === 0);
    ok('no page errors', errors.length === 0, errors);
    await page.close();

    // the app: zones from the hash, drawn with the mouse, removed, exported
    {
        const { page: p, errors: e2 } = await openApp(browser, { hash: 'mode=everyFrame&exclude=0.0125,0.018519,0.195833,0.066667' });
        ok('zones from the hash', (await p.evaluate(() => __ph.params.zones.length)) === 1);
        await p.selectOption('#scene', 'osd');
        await p.click('#openScene');
        await p.waitForFunction(() => __ph.results.length >= 1, null, { timeout: 30000 });
        ok('zone list shows source pixels', (await p.textContent('#zoneList')).includes('12,10 188×36 px'), await p.textContent('#zoneList'));
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
        const st = await p.evaluate(() => __ph.stats.score);
        ok('OSD scene in the app with both zones: no false positives', st && st.fpPerFrame < 0.05 && st.hitRate >= 0.9, st);
        const [dl] = await Promise.all([p.waitForEvent('download'), p.click('#exportJson')]);
        const json = JSON.parse(await (await import('fs')).promises.readFile(await dl.path(), 'utf8'));
        ok('export records the zones in source pixels', json.meta.excludeZones.length === 2 && JSON.stringify(json.meta.excludeZones[0].px) === '[12,10,188,36]', json.meta.excludeZones);
        await p.click('#zoneList li:first-child button');
        ok('× removes a zone', (await p.evaluate(() => __ph.params.zones.length)) === 1);
        await p.fill('#zoneText', '0.1,0.1,0.2,0.2;0.5,0.5,0.1,0.1');
        await p.press('#zoneText', 'Enter');
        await p.locator('#zoneText').blur();
        ok('zones typed as text', (await p.evaluate(() => __ph.params.zones.length)) === 2);
        await p.click('#clearZones');
        ok('Clear all', (await p.evaluate(() => __ph.params.zones.length)) === 0);
        ok('no page errors (app)', e2.length === 0, e2);
        await p.close();
    }
} finally {
    await browser.close();
}
