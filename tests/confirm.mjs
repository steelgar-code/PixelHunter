// Temporal confirmation (M4) on synthetic scenes: confirmed within 5 frames of appearing, one id
// per target while visible, < 1 confirmed false detection per 10 s; the JSON export.
import fs from 'fs';
import { launch, ok, openApp, sleep } from './lib/env.mjs';
import { instrumentMats } from './lib/mats.mjs';
import { SCENES } from '../src/scenes.js';

const browser = await launch();
try {
    const { page, errors } = await openApp(browser);
    await page.evaluate(instrumentMats);
    await page.evaluate(async () => {
        const { createScene, greyToRgba } = await import('/src/synth.js');
        const { createPipeline } = await import('/src/pipeline.js');
        const { createScore, matchFrame } = await import('/src/score.js');
        window.runConfirm = (sceneOpts, params = {}) => {
            const s = createScene(sceneOpts);
            const pipe = createPipeline(cv, { ...window.__ph.params, ...params });
            const raw = createScore({ fps: s.fps }), conf = createScore({ fps: s.fps });
            const ids = {};
            for (let k = 0; k < s.frames; k++) {
                const f = s.frame(k);
                const r = pipe.push({ imageData: new ImageData(greyToRgba(f.grey), s.width, s.height), width: s.width, height: s.height,
                    time: k / s.fps, frame: k, seq: k, gap: 0, jump: k === 0, truth: f.truth }).result;
                if (!r || !r.detect.ok) continue;
                raw.add(r.frame, r.candidates, r.truth.targets);
                const boxes = r.confirmed.map(t => t.box);
                const m = conf.add(r.frame, boxes, r.truth.targets);
                for (const mt of m.matches) (ids[mt.target] ??= new Set()).add(r.confirmed[mt.detection].id);
            }
            pipe.dispose();
            const round = o => ({ ...o, hitRate: o.hitRate === null ? null : +o.hitRate.toFixed(3), fpPerFrame: +o.fpPerFrame.toFixed(3), fpPer10s: +o.fpPer10s.toFixed(2) });
            return { raw: round(raw.summary()), conf: round(conf.summary()), ids: Object.fromEntries(Object.entries(ids).map(([k, v]) => [k, [...v]])) };
        };
    });
    const run = (scene, params) => page.evaluate(([s, p]) => window.runConfirm(s, p), [scene, params]);

    console.log('\nConfirmed detections (defaults, 150 frames = 6 s each):');
    const res = {};
    for (const key of Object.keys(SCENES)) {
        res[key] = await run(SCENES[key].options, { zones: SCENES[key].zones || [], ...(SCENES[key].params || {}) });
        const r = res[key];
        console.log(`  ${key.padEnd(14)} raw: hit ${r.raw.hitRate ?? '–'} FP/frame ${r.raw.fpPerFrame}   confirmed: hit ${r.conf.hitRate ?? '–'} FP/10 s ${r.conf.fpPer10s}  latency ${JSON.stringify(r.conf.latency)}  ids ${JSON.stringify(r.ids)}`);
    }
    // handheld-dots has a target too slow for stride 1 (1.9 px/frame, see the M3 results): checked at stride 3
    res['handheld-dots, stride 3'] = await run(SCENES['handheld-dots'].options, { stride: 3 });
    for (const key of ['pan-dots', 'handheld-dots, stride 3', 'drone-edges', 'exposure']) {
        const r = res[key];
        const lat = Object.values(r.conf.latency);
        ok(`${key}: every target confirmed within 5 frames of appearing`, lat.length > 0 && lat.every(v => v !== null && v <= 4), r.conf.latency);
        ok(`${key}: one id per target while visible`, Object.values(r.ids).every(v => v.length === 1), r.ids);
    }
    // the slow target in handheld-dots needs stride; at stride 1 it is the one the hit rate misses
    ok('fast targets tracked while visible (confirmed hit ≥ 90 %)', ['pan-dots', 'drone-edges', 'exposure'].every(k => res[k].conf.hitRate >= 0.9),
        Object.fromEntries(Object.entries(res).map(([k, r]) => [k, r.conf.hitRate])));
    ok('static scene, moving camera: < 1 confirmed false detection per 10 s', res['static-scene'].conf.fpPer10s < 1, res['static-scene'].conf);
    // trees (parallax, wind) are the hard case for the robust detector: there the shift check
    // brings it down to a few per 10 s (adaptive mode gets it to none; see the benchmark)
    ok('… and on every scene but the trees', Object.entries(res).every(([k, r]) => k === 'trees' || r.conf.fpPer10s < 1), Object.fromEntries(Object.entries(res).map(([k, r]) => [k, r.conf.fpPer10s])));
    ok('trees with the shift check: < 5 confirmed false detections per 10 s', res.trees.conf.fpPer10s < 5, res.trees.conf.fpPer10s);
    {
        const r = res['handheld-dots, stride 3'];
        ok('handheld-dots at stride 3: the slow target is confirmed too', r.conf.hitRate >= 0.9 && Object.keys(r.ids).length === 2, { hit: r.conf.hitRate, ids: r.ids, fp: r.conf.fpPer10s });
    }
    {
        // more static footage: 3 seeds of the hard-edged handheld scene, 10 s each
        let fp = 0, frames = 0;
        for (const seed of [101, 102, 103]) {
            const r = await run({ ...SCENES['static-scene'].options, frames: 250, seed }, {});
            fp += r.conf.fp; frames += r.conf.frames;
        }
        ok('30 s of static hard-edged scenes: < 1 confirmed false detection per 10 s', fp / frames * 250 < 1, { fp, frames });
    }
    ok('no Mats left behind', (await page.evaluate(() => window.__liveMats())) === 0);
    ok('no page errors', errors.length === 0, errors);
    await page.close();

    // export from the app
    for (const procWidth of ['0', '640']) {
        const { page: p, errors: e2 } = await openApp(browser, { hash: `mode=everyFrame&procWidth=${procWidth}` });
        await p.selectOption('#scene', 'pan-dots');
        await p.click('#openScene');
        await p.waitForFunction(() => __ph.results.length >= 1, null, { timeout: 30000 });
        await p.click('#play');
        await p.waitForFunction(() => __ph.shown.frame >= 40, null, { timeout: 60000 });
        await p.click('#play');
        await sleep(300);
        const count = await p.evaluate(() => __ph.log.count);
        const label = await p.evaluate(() => document.getElementById('logCount').textContent);
        const [download] = await Promise.all([p.waitForEvent('download'), p.click('#exportJson')]);
        const data = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
        ok(`export (processing ${procWidth === '0' ? 'source' : procWidth}): file name, meta`, download.suggestedFilename().endsWith('.detections.json')
            && data.meta.app === 'PixelHunter' && data.meta.width === 960 && data.meta.height === 540 && data.meta.params.detectMode === 'robust'
            && Math.abs(data.meta.fps - 25) < 0.01, { name: download.suggestedFilename(), meta: { ...data.meta, params: undefined } });
        ok(`export (${procWidth}): every logged detection, as shown in the panel`, data.detections.length === count && count > 50 && label.startsWith(`${count} confirmed`), { count, label });
        const d = data.detections[data.detections.length - 1];
        ok(`export (${procWidth}): entries have frame, time, track id, box, centre, velocity`, ['frame', 'time', 'trackId', 'box', 'cx', 'cy', 'area', 'vx', 'vy'].every(k => k in d) && d.box.length === 4, d);
        // positions in source pixels: compare with the scene's ground truth
        const { createScene } = await import('../src/synth.js');
        const scene = createScene(SCENES['pan-dots'].options);
        let worst = 0;
        for (const det of data.detections) {
            const near = Math.min(...scene.truth(det.frame).targets.map(t => Math.hypot(t.cx - det.cx, t.cy - det.cy)));
            worst = Math.max(worst, near);
        }
        // the mask keeps the parts of a moving object that differ from both neighbours, so a 5×5
        // target's centroid can sit ~1–2 px off its centre
        ok(`export (${procWidth}): detections within ${procWidth === '0' ? 2 : 2.5} px of the truth in source pixels`, worst < (procWidth === '0' ? 2 : 2.5), +worst.toFixed(2));
        await p.click('#clearLog');
        await sleep(300);
        ok(`export (${procWidth}): Clear empties the log`, (await p.evaluate(() => __ph.log.count)) === 0 && (await p.$eval('#exportJson', b => b.disabled)));
        ok(`export (${procWidth}): no page errors`, e2.length === 0, e2);
        await p.close();
    }
} finally {
    await browser.close();
}
