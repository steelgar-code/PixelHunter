// Robust (M3) vs basic (M2) detection on synthetic scenes, plus the compression study through
// H.264 in the app. Prints the results tables.
import { launch, ok, openApp, sleep } from './lib/env.mjs';
import { instrumentMats } from './lib/mats.mjs';
import { sceneClip } from './lib/clips.mjs';
import { SCENES } from '../src/scenes.js';
import { createScore } from '../src/score.js';

const browser = await launch();
const pct = v => (v === null ? '  –' : `${Math.round(v * 100)}%`.padStart(4));
const row = r => `hit ${pct(r.hitRate)}  FP/frame ${String(r.fpPerFrame).padStart(5)}`;

try {
    const { page, errors } = await openApp(browser);
    await page.evaluate(instrumentMats);
    await page.evaluate(async () => {
        const { createScene, greyToRgba } = await import('/src/synth.js');
        const { createPipeline } = await import('/src/pipeline.js');
        const { createScore } = await import('/src/score.js');
        window.runScene = (sceneOpts, params = {}) => {
            const s = createScene(sceneOpts);
            const pipe = createPipeline(cv, { ...window.__ph.params, ...params });
            const score = createScore({ fps: s.fps });
            const ms = [];
            for (let k = 0; k < s.frames; k++) {
                const f = s.frame(k);
                const r = pipe.push({ imageData: new ImageData(greyToRgba(f.grey), s.width, s.height), width: s.width, height: s.height,
                    time: k / s.fps, frame: k, seq: k, gap: 0, jump: k === 0, truth: f.truth }).result;
                if (!r || !r.detect.ok) continue;
                score.add(r.frame, r.candidates, r.truth.targets);
                ms.push(r.timings.detect);
            }
            pipe.dispose();
            ms.sort((a, b) => a - b);
            const sum = score.summary();
            return { ...sum, detectMs: +ms[ms.length >> 1].toFixed(1), hitRate: sum.hitRate === null ? null : +sum.hitRate.toFixed(3),
                fpPerFrame: +sum.fpPerFrame.toFixed(2) };
        };
    });
    const run = (scene, params) => page.evaluate(([s, p]) => window.runScene(s, p), [scene, params]);
    const basic = { detectMode: 'basic' }, robust = { detectMode: 'robust' };

    // 1. scenarios, basic vs robust
    const scen = {
        'pan-dots': { ...SCENES['pan-dots'].options, frames: 80 },
        'drone-edges': { ...SCENES['drone-edges'].options, frames: 80 },
        'static-scene': { ...SCENES['static-scene'].options, frames: 80 },
        'exposure': { ...SCENES['exposure'].options, frames: 80 },
    };
    const table = {};
    for (const [k, s] of Object.entries(scen)) table[k] = { basic: await run(s, basic), robust: await run(s, robust) };
    table['drone-edges ±1 px jitter'] = { basic: await run(scen['drone-edges'], { ...basic, hJitter: 1 }), robust: await run(scen['drone-edges'], { ...robust, hJitter: 1 }) };
    table['exposure, no brightness match'] = { basic: table.exposure.basic, robust: await run(scen.exposure, { ...robust, brightness: false }) };
    // a single jump is absorbed by the three-frame AND alone; a ramp of more than the threshold
    // per frame (each frame differs from both neighbours) needs brightness matching
    const step = { ...scen.exposure, exposure: { from: 40, to: 44, gain: 100 } };
    table['exposure ramp 25/frame'] = { basic: await run(step, basic), robust: await run(step, robust) };
    table['exposure ramp 25/frame, no match'] = { basic: table['exposure ramp 25/frame'].basic, robust: await run(step, { ...robust, brightness: false }) };
    console.log('\nBasic vs robust (960×540, defaults, 80 frames):');
    for (const [k, r] of Object.entries(table)) console.log(`  ${k.padEnd(30)} basic: ${row(r.basic)}   robust: ${row(r.robust)}`);
    ok('robust: far fewer false positives on hard edges (drone)', table['drone-edges'].robust.fpPerFrame < table['drone-edges'].basic.fpPerFrame / 20, table['drone-edges']);
    ok('robust: static scene with hard edges nearly quiet (< 0.2 FP/frame)', table['static-scene'].robust.fpPerFrame < 0.2, table['static-scene'].robust);
    ok('robust: tolerates ±1 px registration error', table['drone-edges ±1 px jitter'].robust.fpPerFrame < 1 && table['drone-edges ±1 px jitter'].robust.hitRate >= 0.9, table['drone-edges ±1 px jitter']);
    const ramp = table['exposure ramp 25/frame'].robust, rampOff = table['exposure ramp 25/frame, no match'].robust;
    // the steep ramp saturates bright areas for a few frames: some misses there are expected
    ok('robust: exposure changes absorbed', table.exposure.robust.fpPerFrame < 0.1 && ramp.fpPerFrame < 0.1 && ramp.hitRate >= 0.85, [table.exposure.robust, ramp]);
    ok('… by brightness matching (off: false positives during the ramp)', rampOff.fp > ramp.fp + 5, [ramp.fp, rampOff.fp]);
    ok('robust: targets still found on the presets', ['pan-dots', 'drone-edges', 'exposure'].every(k => table[k].robust.hitRate >= 0.9), Object.fromEntries(['pan-dots', 'drone-edges', 'exposure'].map(k => [k, table[k].robust.hitRate])));

    // 2. no ghost: one clear mover on a pure pan
    {
        const s = { width: 640, height: 360, frames: 40, camera: 'pan', seed: 31, noise: 2, targets: [{ size: 5, contrast: 80, fx: 200, fy: 150, vx: 8, vy: 3.5 }] };
        const b = await run(s, basic), r = await run(s, robust);
        ok('robust: no ghost at the old position (basic: ~1 FP/frame)', r.fp === 0 && r.hitRate === 1 && b.fpPerFrame > 0.9, { basic: b.fpPerFrame, robust: r.fpPerFrame });
    }

    // 3. size × contrast, robust, 640×360 pan, one bright and one dark target each
    const grid = {};
    console.log('\nRobust, hit rate by size × contrast (640×360 pan, threshold 20, FP/frame in brackets):');
    for (const size of [2, 3, 5]) {
        const line = [];
        for (const contrast of [15, 30, 60]) {
            const s = { width: 640, height: 360, frames: 60, camera: 'pan', seed: 40 + size * 10 + contrast, noise: 2,
                targets: [{ size, contrast, fx: 120, fy: 100, vx: 6 + 3, vy: 2.5 + 2 }, { size, contrast: -contrast, fx: 150, fy: 230, vx: 6 + 3.5, vy: 2.5 - 1 }] };
            const r = await run(s, robust);
            grid[`${size}x${contrast}`] = r;
            line.push(`${String(contrast).padStart(2)}: ${pct(r.hitRate)} (${r.fpPerFrame})`);
        }
        console.log(`  ${size}×${size} px   ${line.join('   ')}`);
    }
    ok('3×3 px at contrast 30: ≥ 95 % of frames, ≤ 0.1 FP/frame', grid['3x30'].hitRate >= 0.95 && grid['3x30'].fpPerFrame <= 0.1, grid['3x30']);
    ok('contrast 15 is below what the threshold finds, and nothing false appears', grid['3x15'].hitRate < 0.2 && grid['3x15'].fpPerFrame <= 0.1, grid['3x15']);
    ok('contrast 60: every size found in ≥ 95 % of frames', ['2x60', '3x60', '5x60'].every(k => grid[k].hitRate >= 0.95), ['2x60', '3x60', '5x60'].map(k => grid[k].hitRate));

    // 4. slow movers need a larger stride
    {
        const s = { width: 640, height: 360, frames: 60, camera: 'handheld', seed: 50, noise: 2,
            targets: [{ size: 3, contrast: 50, fx: 400, fy: 180, vx: 1.2, vy: 0.6 }] };     // world velocity = against the background: 1.3 px/frame
        const results = {};
        for (const st of [1, 2, 3, 4]) results[st] = await run(s, { ...robust, stride: st });
        console.log('\nSlow mover (3×3 px, 1.3 px/frame against the background), robust, by stride:');
        console.log('  ' + Object.entries(results).map(([st, r]) => `stride ${st}: ${pct(r.hitRate)} (${r.fpPerFrame})`).join('   '));
        ok('slow mover: missed at stride 1, found at stride 3+', results[1].hitRate < 0.5 && results[3].hitRate >= 0.9 && results[4].hitRate >= 0.9, Object.fromEntries(Object.entries(results).map(([k, r]) => [k, r.hitRate])));
        ok('larger stride stays quiet', results[3].fpPerFrame <= 0.2 && results[4].fpPerFrame <= 0.2, [results[3].fpPerFrame, results[4].fpPerFrame]);
    }
    ok('no Mats left behind', (await page.evaluate(() => window.__liveMats())) === 0);
    ok('no page errors', errors.length === 0, errors);
    await page.close();

    // 5. compression: the size × contrast scene encoded with x264, played in the app (every frame)
    console.log('\nRobust, hit rate through H.264 by CRF (640×360 pan, played in the app; FP/frame in brackets):');
    const compression = {};
    for (const [size, contrast] of [[2, 60], [3, 30], [3, 60], [5, 30]]) {
        const sceneOpts = { width: 640, height: 360, frames: 60, camera: 'pan', seed: 40 + size * 10 + contrast, noise: 2,
            targets: [{ size, contrast, fx: 120, fy: 100, vx: 9, vy: 4.5 }, { size, contrast: -contrast, fx: 150, fy: 230, vx: 9.5, vy: 1.5 }] };
        const line = [];
        for (const crf of [18, 23, 28]) {
            const clip = await sceneClip(sceneOpts, { crf });
            const { page: p } = await openApp(browser, { hash: 'mode=everyFrame&detectMode=robust&stride=1' });
            await p.setInputFiles('#file', clip.path);
            await p.waitForFunction(() => __ph.results.length >= 1, null, { timeout: 20000 });
            await p.click('#play');
            await p.waitForFunction(() => !__ph.loop.playing, null, { timeout: 120000 });
            await sleep(200);
            const res = await p.evaluate(() => __ph.results);
            await p.close();
            const sc = createScore({ fps: 25 });
            for (const r of res) if (r.detectOk) sc.add(r.frame, r.candidates.map(([cx, cy]) => ({ cx, cy })), clip.truth[r.frame].targets);
            const sum = sc.summary();
            compression[`${size}x${contrast}@${crf}`] = sum;
            line.push(`CRF ${crf}: ${pct(sum.hitRate)} (${sum.fpPerFrame.toFixed(2)})`);
        }
        console.log(`  ${size}×${size} px, contrast ${String(contrast).padStart(2)}   ${line.join('   ')}`);
    }
    ok('compression: 3×3 px at contrast 60 survives CRF 28', compression['3x60@28'].hitRate >= 0.9, compression['3x60@28']);
    ok('compression: 3×3 px at contrast 30 mostly survives CRF 18', compression['3x30@18'].hitRate >= 0.8, compression['3x30@18']);
    ok('compression: false positives stay low at every CRF', Object.values(compression).every(s => s.fpPerFrame <= 0.3), Object.fromEntries(Object.entries(compression).map(([k, s]) => [k, +s.fpPerFrame.toFixed(2)])));
} finally {
    await browser.close();
}
