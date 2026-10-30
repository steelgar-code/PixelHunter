// Objects that stop and go, through the whole pipeline: the track is held while the object
// stands still (nothing moves, so nothing is detected) and keeps its id when it moves on.
import { launch, ok, openApp } from './lib/env.mjs';

const browser = await launch();
try {
    const { page, errors } = await openApp(browser);
    const run = params => page.evaluate(async params => {
        const { createScene, greyToRgba } = await import('/src/synth.js');
        const { createPipeline } = await import('/src/pipeline.js');
        // moves 30 frames, stands 40 (1.6 s), moves 30, stands 15, moves on
        // a slow drifting, slightly shaking camera, so the target stays in view while it stands
        const camera = k => ({ cx: 1.2 * k + 1.5 * Math.sin(k * 0.7), cy: 0.4 * k + Math.sin(k * 0.9 + 1), rot: 0.003 * Math.sin(k * 0.3), scale: 1, px: 0, py: 0 });
        const s = createScene({ width: 640, height: 360, frames: 140, camera, seed: 91, noise: 2,
            targets: [{ size: 3, contrast: 60, fx: 120, fy: 140, vx: 3.5, vy: 1, stops: [[30, 70], [100, 115]] }] });
        const pipe = createPipeline(cv, { ...window.__ph.params, ...params });
        const rows = [];
        for (let k = 0; k < s.frames; k++) {
            const f = s.frame(k);
            const r = pipe.push({ imageData: new ImageData(greyToRgba(f.grey), s.width, s.height), width: s.width, height: s.height,
                time: k / s.fps, frame: k, seq: k, gap: 0, jump: k === 0, truth: f.truth }).result;
            if (r) rows.push({ k: r.frame, conf: r.confirmed.map(t => t.id), held: r.held.map(t => t.id) });
        }
        pipe.dispose();
        return rows;
    }, params);
    const at = (rows, a, b) => rows.filter(r => r.k >= a && r.k < b);
    const ids = rs => [...new Set(rs.flatMap(r => r.conf))];

    const rows = await run({});
    ok('moving: confirmed', at(rows, 5, 30).every(r => r.conf.length === 1), at(rows, 5, 30).map(r => r.conf.length));
    ok('standing still 1.6 s: held, no detection shown', at(rows, 40, 70).every(r => r.conf.length === 0 && r.held.length === 1), at(rows, 40, 70).map(r => [r.conf.length, r.held.length]));
    ok('moving again: the same id, shown again within 4 frames', ids(rows).length === 1 && at(rows, 74, 100).every(r => r.conf.length === 1), { ids: ids(rows), after: at(rows, 70, 76).map(r => r.conf) });
    ok('a second, shorter stop too', ids(at(rows, 119, 140)).join() === ids(rows).join() && at(rows, 119, 140).every(r => r.conf.length === 1), at(rows, 114, 122).map(r => r.conf));

    const off = await run({ holdFrames: 0 });
    ok('without holding (Keep lost tracks 0) it gets a new id after each stop', ids(off).length === 3, ids(off));
    ok('no page errors', errors.length === 0, errors);
} finally {
    await browser.close();
}
