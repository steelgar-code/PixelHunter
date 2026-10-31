// Background-shift check (robust detector): false detections on trees (parallax, wind) are
// dropped, real targets are not, also in front of the trees, faint ones, when cropped and with blur.
import { launch, ok, openApp } from './lib/env.mjs';
import { instrumentMats } from './lib/mats.mjs';
import { SCENES } from '../src/scenes.js';

const browser = await launch();
try {
    const { page, errors } = await openApp(browser);
    await page.evaluate(instrumentMats);
    await page.evaluate(async () => {
        const { createScene, greyToRgba } = await import('/src/synth.js');
        const { createPipeline } = await import('/src/pipeline.js');
        const { createScore } = await import('/src/score.js');
        window.run = (o, params) => {
            const s = createScene(o);
            // the shift check is measured against the robust detector (adaptive mode is quiet on
            // these trees without it); presets passed in bring their own detector
            const pipe = createPipeline(cv, { ...window.__ph.params, detectMode: 'robust', ...params });
            const raw = createScore({ fps: s.fps }), conf = createScore({ fps: s.fps });
            const ms = [];
            for (let k = 0; k < s.frames; k++) {
                const f = s.frame(k);
                const r = pipe.push({ imageData: new ImageData(greyToRgba(f.grey), s.width, s.height), width: s.width, height: s.height,
                    time: k / s.fps, frame: k, seq: k, gap: 0, jump: k === 0, truth: f.truth }).result;
                if (!r || !r.detect.ok) continue;
                const sc = r.scale, tt = r.truth.targets.map(t => ({ ...t, cx: (t.cx + 0.5) * sc - 0.5, cy: (t.cy + 0.5) * sc - 0.5 }));
                raw.add(r.frame, r.candidates, tt);
                conf.add(r.frame, r.confirmed.map(t => t.box), tt);
                ms.push(r.timings.detect);
            }
            pipe.dispose();
            ms.sort((a, b) => a - b);
            const a = raw.summary(), c = conf.summary();
            return { hit: a.hitRate, fp: +a.fpPerFrame.toFixed(2), conf: c.hitRate, confFp10s: +c.fpPer10s.toFixed(1), ms: +ms[ms.length >> 1].toFixed(1) };
        };
    });
    const run = (o, p) => page.evaluate(([o, p]) => window.run(o, p), [o, p]);
    const trees = SCENES.trees.options;

    const off1 = await run(trees, {}), on1 = await run(trees, { shiftCheck: true });
    const off2 = await run(trees, { stride: 2 }), on2 = await run(trees, { stride: 2, shiftCheck: true });
    console.log('Trees scene (parallax 8–22 %, sway 1–3 px), 150 frames:');
    for (const [k, r] of Object.entries({ 'stride 1, off': off1, 'stride 1, on': on1, 'stride 2, off': off2, 'stride 2, on': on2 })) {
        console.log(`  ${k.padEnd(14)} raw hit ${Math.round(r.hit * 100)}% FP/frame ${r.fp} | confirmed hit ${Math.round(r.conf * 100)}% FP/10 s ${r.confFp10s} | detect ${r.ms} ms`);
    }
    ok('stride 1: confirmed false detections on the trees at least 3× fewer', on1.confFp10s * 3 <= off1.confFp10s && off1.confFp10s > 5, [off1.confFp10s, on1.confFp10s]);
    ok('stride 2: at least 50× fewer', on2.confFp10s * 50 <= off2.confFp10s, [off2.confFp10s, on2.confFp10s]);
    ok('… with no target lost', on1.hit >= off1.hit - 0.01 && on1.conf >= off1.conf - 0.01 && on2.conf >= off2.conf - 0.01, [off1.conf, on1.conf, off2.conf, on2.conf]);
    ok('… and no noticeable cost (< 5 ms per frame)', on2.ms - off2.ms < 5, [off2.ms, on2.ms]);

    // targets crossing in front of the trees
    {
        const o = { ...trees, frames: 100, targets: [
            { size: 4, contrast: 80, fx: 330, fy: 375, vx: 6 + 2.5, vy: 2.5 },        // across the big tree at 420,380
            { size: 3, contrast: -60, fx: 60, fy: 100, vx: 6 + 3, vy: 2.5 + 0.6 },     // across the tree at 150,120
            { size: 3, contrast: 70, fx: 640, fy: 120, vx: 6 + 2.2, vy: 2.5 + 1.2 },   // across the tree at 700,160
        ] };
        const a = await run(o, {}), b = await run(o, { shiftCheck: true });
        ok('targets crossing in front of trees: none lost', b.hit >= a.hit - 0.02 && b.conf >= a.conf - 0.02, { off: [a.hit, a.conf], on: [b.hit, b.conf] });
    }
    // the other presets' scenes: nothing changes
    for (const key of ['pan-dots', 'drone-edges', 'exposure']) {
        const a = await run(SCENES[key].options, {}), b = await run(SCENES[key].options, { shiftCheck: true });
        ok(`${key}: same hit rate with the check`, Math.abs(a.hit - b.hit) <= 0.01 && Math.abs(a.conf - b.conf) <= 0.01, { off: [a.hit, a.conf], on: [b.hit, b.conf] });
    }
    // faint 1–2 px dots on textured ground (Highest preset)
    {
        const { PRESETS } = await import('../src/params.js');
        const o = { width: 960, height: 540, frames: 100, camera: 'pan', seed: 71, noise: 2,
            targets: [{ size: 1, contrast: 40, fx: 200, fy: 150, vx: 6.8, vy: 2.5 }, { size: 2, contrast: 30, fx: 300, fy: 420, vx: 7.2, vy: 2.9 }] };
        const a = await run(o, PRESETS.highest.values), b = await run(o, { ...PRESETS.highest.values, shiftCheck: true });
        ok('faint 1–2 px slow dots (Highest): none lost', b.hit >= a.hit - 0.02 && b.conf >= a.conf - 0.02, { off: [a.hit, a.conf], on: [b.hit, b.conf] });
    }
    // the cropped and blurred paths read the right pixels
    {
        const inc = [{ x: 0, y: 0.4, w: 0.7, h: 0.6 }];
        const full = await run(trees, { stride: 2, shiftCheck: true }), crop = await run(trees, { stride: 2, shiftCheck: true, include: inc });
        const cropOff = await run(trees, { stride: 2, include: inc });
        // (targets outside the zone can't be found: hit rates compared with the same zone, check off)
        ok('inside an inclusion zone it works the same', crop.confFp10s * 20 <= cropOff.confFp10s && crop.hit >= cropOff.hit - 0.01,
            { fp: [cropOff.confFp10s, crop.confFp10s], hit: [cropOff.hit, crop.hit], full: full.confFp10s });
        const blurOff = await run(trees, { stride: 2, blur: true }), blurOn = await run(trees, { stride: 2, blur: true, shiftCheck: true });
        ok('with blur on it works too', blurOn.confFp10s * 10 <= blurOff.confFp10s, [blurOff.confFp10s, blurOn.confFp10s]);
    }
    ok('no Mats left behind', (await page.evaluate(() => window.__liveMats())) === 0);
    ok('no page errors', errors.length === 0, errors);
    await page.close();

    // the app: grey boxes for dropped candidates, count in the stats
    const { page: p, errors: e2 } = await openApp(browser, { hash: 'mode=everyFrame&stride=2&shiftCheck=true' });
    await p.selectOption('#scene', 'trees');
    await p.click('#openScene');
    await p.waitForFunction(() => __ph.results.length >= 1, null, { timeout: 30000 });
    for (let i = 0; i < 8; i++) await p.click('#step');
    await p.waitForTimeout(400);
    ok('stats show how many were dropped', /dropped: .*\d+ shift/.test(await p.textContent('#stCand')), await p.textContent('#stCand'));
    ok('turning a preset on leaves the check alone', await p.evaluate(() => { __ph.applyPreset('low'); return __ph.params.shiftCheck === true; }));
    ok('no page errors (app)', e2.length === 0, e2);
} finally {
    await browser.close();
}
