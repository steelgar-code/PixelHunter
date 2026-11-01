// Compressed footage: flat sky through H.264 at CRF 28 with a keyframe every 30 frames. The
// adaptive detector's min mean contrast keeps compression blocks out of the candidates, and the
// Compressed preset (confirmation by evidence) confirms none of what is left, while targets in
// the sky are still confirmed.
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { launch, ok, openApp } from './lib/env.mjs';
import { sceneClip } from './lib/clips.mjs';
import { PRESETS } from '../src/params.js';

const dot = (size, contrast, fx, fy, vx, vy) => ({ size, contrast, fx, fy, vx, vy });
const base = { width: 640, height: 360, noise: 2, frames: 150, camera: 'handheld', seed: 101, sky: { fy: 170 } };
async function grey(scene) {
    const clip = await sceneClip(scene, { crf: 28, gop: 30 });
    const out = `${clip.path}.gray`;
    if (!fs.existsSync(out)) spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', clip.path, '-f', 'rawvideo', '-pix_fmt', 'gray', out]);
    return { file: path.basename(out), truth: clip.truth };
}
const empty = await grey({ ...base, targets: [] });
const sky = await grey({ ...base, targets: [dot(3, -20, 120, 70, 6.5, 0.6), dot(2, -30, 420, 120, 5.5, -0.4)] });

const browser = await launch();
try {
    const { page, errors } = await openApp(browser);
    await page.evaluate(async () => {
        const { createPipeline } = await import('/src/pipeline.js');
        const { greyToRgba } = await import('/src/synth.js');
        const { matchFrame } = await import('/src/score.js');
        window.run = async (url, truth, params) => {
            const buf = new Uint8Array(await (await fetch(url)).arrayBuffer());
            const W = 640, H = 360, n = Math.min(truth.length, Math.floor(buf.length / (W * H)));
            const pipe = createPipeline(cv, { ...window.__ph.params, mode: 'everyFrame', ...params });
            let raw = 0, frames = 0, tf = 0, ctp = 0, rgba;
            const tracks = {};
            for (let k = 0; k < n; k++) {
                rgba = greyToRgba(buf.subarray(k * W * H, (k + 1) * W * H), rgba);
                const r = pipe.push({ imageData: new ImageData(rgba, W, H), width: W, height: H, time: k / 25, frame: k, seq: k, gap: 0, jump: k === 0, truth: truth[k] }).result;
                if (!r || !r.detect.ok) continue;
                frames++;
                const tt = truth[r.frame].targets;
                raw += matchFrame(r.candidates, tt).fp;
                tf += tt.length;
                const m = matchFrame(r.confirmed.map(t => t.box), tt);
                ctp += m.tp;
                const hit = new Set(m.matches.map(x => x.detection));
                r.confirmed.forEach((t, i) => { const e = tracks[t.id] ??= { n: 0, hit: 0 }; e.n++; if (hit.has(i)) e.hit++; });
            }
            pipe.dispose();
            return { rawFp: +(raw / frames).toFixed(2), conf: tf ? +(ctp / tf).toFixed(2) : null, falseTracks: Object.values(tracks).filter(e => e.hit < e.n / 2).length };
        };
    });
    const run = (clip, params) => page.evaluate(([u, t, p]) => window.run(u, t, p), [new URL(`tests/.cache/${clip.file}`, page.url()).href, clip.truth, params]);
    const off = await run(empty, { minMean: 0 }), mid = await run(empty, {}), comp = await run(empty, PRESETS.compressed.values);
    console.log(`Sky over ground, CRF 28, no target: raw false candidates per frame ${off.rawFp} (min mean off) → ${mid.rawFp} (Mid); false tracks ${off.falseTracks} → ${mid.falseTracks} → ${comp.falseTracks} (Compressed)`);
    ok('min mean contrast (default): at least 4× fewer false candidates on compressed sky', mid.rawFp * 4 <= off.rawFp, [off.rawFp, mid.rawFp]);
    ok('… and fewer false tracks', mid.falseTracks < off.falseTracks, [off.falseTracks, mid.falseTracks]);
    ok('Compressed preset: no false tracks', comp.falseTracks === 0, comp.falseTracks);
    const t = await run(sky, PRESETS.compressed.values), tm = await run(sky, {});
    console.log(`Targets in the compressed sky: confirmed ${tm.conf} (Mid, ${tm.falseTracks} false tracks), ${t.conf} (Compressed, ${t.falseTracks})`);
    ok('Compressed preset: targets in the sky still confirmed, no false tracks', t.conf >= 0.45 && t.falseTracks === 0, t);
    ok('no page errors', errors.length === 0, errors);
} finally {
    await browser.close();
}
