// Confirmation options in the app's pipeline: a lower threshold near confirmed objects keeps a
// fading target, contrast against the surroundings is measured for each candidate when asked
// for, and confirming by time or with strong sightings / contrast required still finds clear
// targets. (The rules themselves: tracker.mjs.)
import { launch, ok, openApp } from './lib/env.mjs';
import { SCENES } from '../src/scenes.js';

const browser = await launch();
try {
    const { page, errors } = await openApp(browser);
    await page.evaluate(async () => {
        const { createScene, greyToRgba } = await import('/src/synth.js');
        const { createPipeline } = await import('/src/pipeline.js');
        window.run = (o, params, from = 0) => {
            const s = createScene(o);
            const pipe = createPipeline(cv, { ...window.__ph.params, ...params });
            let hit = 0, n = 0, spatial = 0, cands = 0;
            for (let k = 0; k < s.frames; k++) {
                const f = s.frame(k);
                const r = pipe.push({ imageData: new ImageData(greyToRgba(f.grey), s.width, s.height), width: s.width, height: s.height, time: k / 25, frame: k, seq: k, gap: 0, jump: k === 0, truth: f.truth }).result;
                if (!r || !r.detect.ok) continue;
                cands += r.candidates.length;
                spatial += r.candidates.filter(c => Number.isFinite(c.spatial)).length;
                if (r.frame < from) continue;
                for (const t of r.truth.targets) {
                    n++;
                    if (r.confirmed.some(c => Math.hypot(c.box.cx - t.cx, c.box.cy - t.cy) < 3)) hit++;
                }
            }
            pipe.dispose();
            return { hit: n ? +(hit / n).toFixed(2) : null, spatial, cands };
        };
    });
    const run = (o, p, from) => page.evaluate(([o, p, f]) => window.run(o, p, f), [o, p, from]);

    // a 3 px target at contrast 40 for 40 frames, then fading to 9
    const vx = 6 + 2, vy = 2.5 + 0.7;
    const fade = { width: 640, height: 360, frames: 120, camera: 'pan', seed: 41, noise: 2,
        targets: [{ size: 3, contrast: 40, x: 0, y: 0, vx, vy, to: 40 }, { size: 3, contrast: 9, x: vx * 41, y: vy * 41, vx, vy, from: 41 }] };
    const off = await run(fade, {}, 45), near = await run(fade, { nearMargin: 2 }, 45);
    console.log(`fading target, confirmed after it fades: ${off.hit} (off) → ${near.hit} (2σ lower near it)`);
    ok('lower threshold near a confirmed object: a fading target is kept longer', near.hit >= off.hit + 0.05, [off.hit, near.hit]);

    const dots = SCENES['pan-dots'].options;
    const base = await run(dots, {}), sp = await run(dots, { minSpatial: 4 });
    ok('contrast against the surroundings is measured only when asked for', base.spatial === 0 && sp.spatial === sp.cands && sp.cands > 0, [base.spatial, sp.spatial, sp.cands]);
    ok('… and clear dots still confirm with it (min 4 grey)', sp.hit >= base.hit - 0.05, [base.hit, sp.hit]);
    const tm = await run(dots, { confirmBy: 'time' }), st = await run(dots, { minStrong: 2 });
    ok('confirm by time (3 within 0.3 s): clear dots confirm as with N of M', tm.hit >= base.hit - 0.03, [base.hit, tm.hit]);
    ok('2 strong sightings needed: clear dots confirm as before', st.hit >= base.hit - 0.03, [base.hit, st.hit]);
    ok('no page errors', errors.length === 0, errors);
} finally {
    await browser.close();
}
