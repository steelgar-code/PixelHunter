// egomotion.js on synthetic frames with known camera motion (in the page, real OpenCV.js):
// accuracy of H scaled to full resolution, inliers, grid coverage, failures and recovery,
// no Mat leaks (also in the pipeline's ring buffer).
import { launch, ok, openApp } from './lib/env.mjs';
import { instrumentMats } from './lib/mats.mjs';

const browser = await launch();
try {
    const { page, errors } = await openApp(browser);
    await page.evaluate(instrumentMats);
    await page.evaluate(async () => {
        const { createScene } = await import('/src/synth.js');
        const { createEgomotion } = await import('/src/egomotion.js');
        const { scaleH, maxCornerDiff } = await import('/src/homography.js');

        const toMats = (grey, W, H, sw) => {
            const full = new cv.Mat(H, W, cv.CV_8UC1);
            full.data.set(grey);
            const sh = Math.round(H * sw / W);
            const small = new cv.Mat();
            cv.resize(full, small, new cv.Size(sw, sh), 0, 0, cv.INTER_AREA);
            full.delete();
            return { small, kx: W / sw, ky: H / sh };
        };

        // frames: array of { grey, truthH } at W×H; returns per-update records
        window.runFrames = (frames, W, H, opts = {}) => {
            const ego = createEgomotion(cv, opts);
            const sw = opts.estWidth || 320;
            const out = [];
            let prev = null;
            for (const f of frames) {
                const cur = toMats(f.grey, W, H, sw);
                if (prev) {
                    const r = ego.update(prev.small, cur.small);
                    const rec = { ok: r.ok, reason: r.reason, tracked: r.tracked, inliers: r.inliers, ratio: r.ratio };
                    if (r.ok && f.truthH) rec.err = maxCornerDiff(scaleH(r.H, cur.kx, cur.ky), f.truthH, W, H);
                    // grid cells holding at least one inlier
                    const cells = new Set();
                    const P = r.points;
                    for (let i = 0; i < P.length; i += 5) {
                        if (P[i + 4] === 1) cells.add(Math.min(7, Math.floor(P[i + 2] / cur.small.cols * 8)) + 8 * Math.min(5, Math.floor(P[i + 3] / cur.small.rows * 6)));
                    }
                    rec.coverage = cells.size / 48;
                    out.push(rec);
                    prev.small.delete();
                }
                prev = cur;
            }
            prev.small.delete();
            ego.dispose();
            return out;
        };

        window.sceneFrames = (opts, from = 0, to) => {
            const s = createScene(opts);
            const frames = [];
            for (let k = from; k < (to ?? s.frames); k++) {
                const f = s.frame(k);
                frames.push({ grey: f.grey, truthH: f.truth.H });
            }
            return frames;
        };

        window.summarize = recs => {
            const errs = recs.filter(r => r.err !== undefined).map(r => r.err).sort((a, b) => a - b);
            return {
                n: recs.length, ok: recs.filter(r => r.ok).length,
                medErr: +(errs[errs.length >> 1] || 0).toFixed(3), maxErr: +(errs[errs.length - 1] || 0).toFixed(3),
                minRatio: +Math.min(...recs.map(r => r.ratio)).toFixed(3),
                minCoverage: +Math.min(...recs.map(r => r.coverage)).toFixed(3),
                reasons: [...new Set(recs.filter(r => !r.ok).map(r => r.reason))],
            };
        };
    });

    const scene = (opts, egoOpts = {}) => page.evaluate(([o, e]) => {
        const s = window.sceneFrames(o);
        return window.summarize(window.runFrames(s, o.width, o.height, e));
    }, [opts, egoOpts]);

    for (const [camera, W, H] of [['pan', 640, 360], ['drone', 1280, 720], ['handheld', 1280, 720]]) {
        const r = await scene({ width: W, height: H, frames: 25, camera, seed: 3 });
        ok(`${camera} ${W}×${H}: every frame fitted`, r.ok === r.n, r);
        ok(`${camera} ${W}×${H}: corner error < 0.75 px at full resolution`, r.maxErr < 0.75, { med: r.medErr, max: r.maxErr });
        ok(`${camera} ${W}×${H}: inlier ratio > 0.9`, r.minRatio > 0.9, r.minRatio);
        ok(`${camera} ${W}×${H}: inliers in ≥ 80 % of grid cells`, r.minCoverage >= 0.8, r.minCoverage);
    }

    {
        // a large object moving against the camera motion must not pull the fit
        const r = await scene({ width: 640, height: 360, frames: 20, camera: 'pan', seed: 4,
            targets: [{ size: 70, contrast: 80, fx: 200, fy: 150, vx: 15, vy: 4 }] });
        ok('large mover: fit unaffected', r.ok === r.n && r.maxErr < 0.75, r);
    }

    {
        const r = await page.evaluate(() => {
            const W = 640, H = 360;
            const s = window.sceneFrames({ width: W, height: H, frames: 4, camera: 'pan', seed: 5 });
            const black = { grey: new Uint8ClampedArray(W * H), truthH: null };
            const flat = { grey: new Uint8ClampedArray(W * H).map(() => 120 + Math.random() * 4), truthH: null };
            const recs = window.runFrames([s[0], s[1], black, black, flat, s[2], s[3]], W, H);
            return recs.map(r => [r.ok, r.reason]);
        });
        ok('black frame: not ok (too few tracked points / features)', !r[1][0] && /too few/.test(r[1][1]) && !r[2][0], r);
        ok('flat noisy frame: not ok', !r[3][0] && !r[4][0], r);
        ok('recovers on the next good pair', r[5][0], r);
    }

    {
        const r = await page.evaluate(() => {
            const a = window.sceneFrames({ width: 640, height: 360, frames: 3, camera: 'pan', seed: 6 });
            const b = window.sceneFrames({ width: 640, height: 360, frames: 3, camera: 'drone', seed: 9 });
            return window.runFrames([...a, ...b], 640, 360).map(r => [r.ok, r.reason]);
        });
        ok('scene cut: not ok', r[0][0] && r[1][0] && !r[2][0], r);
        ok('scene cut: next pair fits again', r[3][0] && r[4][0], r);
    }

    {
        const r = await page.evaluate(() => {
            const frames = window.sceneFrames({ width: 640, height: 360, frames: 40, camera: 'handheld', seed: 2 });
            const before = window.__liveMats();
            window.runFrames(frames.slice(0, 10), 640, 360);
            const after10 = window.__liveMats();
            window.runFrames(frames, 640, 360);
            return { before, after10, after40: window.__liveMats() };
        });
        ok('egomotion leaves no Mats behind', r.after10 === r.before && r.after40 === r.before, r);
    }

    {
        const r = await page.evaluate(async () => {
            const { createScene, greyToRgba } = await import('/src/synth.js');
            const { createPipeline } = await import('/src/pipeline.js');
            const s = createScene({ width: 640, height: 360, frames: 60, camera: 'drone', seed: 2 });
            const before = window.__liveMats();
            const pipe = createPipeline(cv, { ...window.__ph.params, estWidth: 320 });
            const counts = [];
            let oks = 0;
            for (let k = 0; k < 60; k++) {
                const f = s.frame(k);
                const imageData = new ImageData(greyToRgba(f.grey), 640, 360);
                const out = pipe.push({ imageData, width: 640, height: 360, time: k / 25, frame: k, seq: k, gap: 0, jump: k === 0 });
                if (out.result && out.result.egoNext.ok) oks++;
                // a debug view every few frames, so its scratch Mats are exercised too
                if (k % 5 === 0) pipe.renderView('stabilised', out, new OffscreenCanvas(640, 360).getContext('2d'));
                counts.push(window.__liveMats());
            }
            pipe.dispose();
            return { before, at5: counts[5], at59: counts[59], after: window.__liveMats(), oks };
        });
        ok('pipeline: every pair fitted', r.oks === 59, r.oks);
        ok('pipeline: Mat count flat while running', r.at59 === r.at5, r);
        ok('pipeline: dispose frees everything', r.after === r.before, r);
    }
    ok('no page errors', errors.length === 0, errors);
} finally {
    await browser.close();
}
