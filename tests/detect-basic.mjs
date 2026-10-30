// Basic detection (M2) on synthetic scenes through the pipeline: a clear mover is found, and
// the baseline numbers for the preset scenes.
import { launch, ok, openApp } from './lib/env.mjs';
import { instrumentMats } from './lib/mats.mjs';

const browser = await launch();
try {
    const { page, errors } = await openApp(browser);
    await page.evaluate(instrumentMats);
    await page.evaluate(async () => {
        const { createScene, greyToRgba } = await import('/src/synth.js');
        const { createPipeline } = await import('/src/pipeline.js');
        const { createScore } = await import('/src/score.js');
        window.runScene = (sceneOpts, params = {}) => {
            const s = createScene(sceneOpts);
            const pipe = createPipeline(cv, { ...window.__ph.params, detectMode: 'basic', ...params });
            const score = createScore({ fps: s.fps });
            const ms = [];
            let skipped = 0;
            for (let k = 0; k < s.frames; k++) {
                const f = s.frame(k);
                const out = pipe.push({ imageData: new ImageData(greyToRgba(f.grey), s.width, s.height), width: s.width, height: s.height,
                    time: k / s.fps, frame: k, seq: k, gap: 0, jump: k === 0, truth: f.truth });
                const r = out.result;
                if (!r) continue;
                if (!r.detect.ok) { skipped++; continue; }
                score.add(r.frame, r.candidates, r.truth.targets);
                ms.push(r.timings.detect);
            }
            pipe.dispose();
            ms.sort((a, b) => a - b);
            const sum = score.summary();
            return { ...sum, skipped, detectMs: +ms[ms.length >> 1].toFixed(1),
                hitRate: sum.hitRate === null ? null : +sum.hitRate.toFixed(3), fpPerFrame: +sum.fpPerFrame.toFixed(2), fpPer10s: +sum.fpPer10s.toFixed(1) };
        };
    });

    {
        const r = await page.evaluate(() => window.runScene({ width: 640, height: 360, frames: 40, camera: 'pan', seed: 31, noise: 2,
            targets: [{ size: 5, contrast: 80, fx: 200, fy: 150, vx: 6 + 2, vy: 2.5 + 1 }] }));
        ok('5×5 high-contrast dot on a pure pan: found in ≥ 95 % of frames', r.hitRate >= 0.95, r);
        ok('… detected from its first frame', r.latency[0] === 0, r.latency);
        ok('only the first frame (no previous frame) goes without detection', r.skipped === 1, r.skipped);
        ok('two-frame differencing leaves a ghost at the old position (one false positive per frame)', r.fpPerFrame >= 0.9 && r.fpPerFrame <= 1.1, r.fpPerFrame);
    }
    {
        const r = await page.evaluate(() => window.runScene({ width: 640, height: 360, frames: 30, camera: 'static', seed: 32, noise: 2, targets: [] }));
        ok('static camera, nothing moving: no false positives', r.fp === 0, r);
    }

    const { SCENES } = await import('../src/scenes.js');
    const baseline = {};
    for (const [key, s] of Object.entries(SCENES)) {
        baseline[key] = await page.evaluate(o => window.runScene(o), { ...s.options, frames: 80 });
    }
    console.log('Baseline (basic mode, defaults, 80 frames each):');
    for (const [key, r] of Object.entries(baseline)) {
        console.log(`  ${key.padEnd(14)} hit ${r.hitRate === null ? '  – ' : (r.hitRate * 100).toFixed(0).padStart(3) + '%'}  FP/frame ${String(r.fpPerFrame).padStart(6)}  detect ${r.detectMs} ms`);
    }
    ok('baseline: every preset runs, only the first frame without detection', Object.values(baseline).every(r => r.skipped === 1), Object.fromEntries(Object.entries(baseline).map(([k, r]) => [k, r.skipped])));
    ok('pipeline with detection leaves no Mats behind', (await page.evaluate(() => window.__liveMats())) === 0);
    ok('no page errors', errors.length === 0, errors);
} finally {
    await browser.close();
}
