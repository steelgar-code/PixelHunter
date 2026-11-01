// Sensitivity presets: valid values, the hash, the buttons in the app, and that each preset
// does what it is for on synthetic scenes (Highest: faint 1–2 px slow dots; Low: large fast
// objects, cheaper; none: confirmed false detections on hard-edged static footage).
import { launch, ok, openApp } from './lib/env.mjs';
import { PRESETS, PARAM_DEFS, coerce, defaults, matchingPreset, resolveParams } from '../src/params.js';

for (const [key, pr] of Object.entries(PRESETS)) {
    const bad = Object.entries(pr.values).filter(([k, v]) => coerce(k, v) !== v);
    ok(`${key}: every value is a valid setting`, bad.length === 0, bad);
    ok(`${key}: matched by its own values`, matchingPreset({ ...defaults(), ...pr.values }) === key);
}
ok('Mid is the defaults', matchingPreset(defaults()) === 'mid');
ok('presets leave playback, view, zones and debug alone', Object.values(PRESETS).every(pr => Object.keys(pr.values).every(k => ['detect', 'track', 'motion'].includes(PARAM_DEFS.find(d => d.key === k).group) && k !== 'zonesMotion')));
{
    const p = resolveParams({ threshold: 40, mode: 'everyFrame' }, { preset: 'highest', stride: '5' });
    ok('#preset= applies over saved values, other hash values over it', p.threshold === PRESETS.highest.values.threshold && p.stride === 5 && p.mode === 'everyFrame', { threshold: p.threshold, stride: p.stride });
}

const browser = await launch();
try {
    const { page, errors } = await openApp(browser);
    await page.evaluate(async () => {
        const { createScene, greyToRgba } = await import('/src/synth.js');
        const { createPipeline } = await import('/src/pipeline.js');
        const { createScore } = await import('/src/score.js');
        window.bench = (sceneOpts, params) => {
            const s = createScene(sceneOpts);
            const pipe = createPipeline(cv, { ...window.__ph.params, ...params });
            const raw = createScore({ fps: s.fps }), conf = createScore({ fps: s.fps });
            const ms = [];
            for (let k = 0; k < s.frames; k++) {
                const f = s.frame(k);
                const r = pipe.push({ imageData: new ImageData(greyToRgba(f.grey), s.width, s.height), width: s.width, height: s.height,
                    time: k / s.fps, frame: k, seq: k, gap: 0, jump: k === 0, truth: f.truth }).result;
                if (!r || !r.detect.ok) continue;
                const sc = r.scale;
                const tt = r.truth.targets.map(t => ({ ...t, cx: (t.cx + 0.5) * sc - 0.5, cy: (t.cy + 0.5) * sc - 0.5 }));
                raw.add(r.frame, r.candidates, tt);
                conf.add(r.frame, r.confirmed.map(t => t.box), tt);
                ms.push(r.timings.total);
            }
            pipe.dispose();
            ms.sort((a, b) => a - b);
            const a = raw.summary(), c = conf.summary();
            return { hit: a.hitRate, fp: +a.fpPerFrame.toFixed(2), conf: c.hitRate, confFp10s: +c.fpPer10s.toFixed(2), ms: +ms[ms.length >> 1].toFixed(1) };
        };
    });
    const dot = (size, contrast, fx, fy, vx, vy) => ({ size, contrast, fx, fy, vx, vy });
    const scenes = {
        'faint slow (1–2 px, contrast 25–40, 0.6–1.2 px/frame)': { width: 960, height: 540, frames: 120, camera: 'pan', seed: 71, noise: 2,
            targets: [dot(1, 40, 200, 150, 6 + 0.8, 2.5), dot(1, -35, 700, 380, 6 - 0.6, 2.5 + 0.6), dot(2, 25, 480, 270, 6 + 1, 2.5 - 0.5), dot(2, 30, 300, 420, 6 + 1.2, 2.5 + 0.4)] },
        'mid (2–5 px, contrast 30–60)': { width: 960, height: 540, frames: 120, camera: 'pan', seed: 21, noise: 2,
            targets: [dot(3, 60, 200, 150, 7.5, 3.3), dot(2, -45, 700, 400, 4.8, 1.9), dot(5, 30, 480, 270, 6.4, 1)] },
        'large fast (8–14 px, 10–18 px/frame, 1920×1080)': { width: 1920, height: 1080, frames: 90, camera: 'handheld', seed: 73, noise: 3, shapes: 60,
            targets: [dot(10, 70, 200, 300, 3 + 18, 2), dot(14, -60, 1700, 700, 3 - 15, -6), dot(8, 80, 900, 900, 3 + 10, -12)] },
        'static, hard edges, handheld': { width: 960, height: 540, frames: 150, camera: 'handheld', seed: 24, noise: 2.5, shapes: 40, targets: [] },
    };
    const res = {};
    console.log('Presets on synthetic scenes (every frame; hit = share of target-frames; FP = per frame before confirmation, per 10 s after):');
    for (const [name, sc] of Object.entries(scenes)) {
        for (const [key, pr] of Object.entries(PRESETS)) {
            const r = res[`${name}|${key}`] = await page.evaluate(([s, p]) => window.bench(s, p), [sc, pr.values]);
            const pct = v => (v === null ? '  –' : `${Math.round(v * 100)}%`.padStart(4));
            console.log(`  ${name.padEnd(50)} ${key.padEnd(8)} raw ${pct(r.hit)} FP ${String(r.fp).padStart(5)} | confirmed ${pct(r.conf)} FP/10s ${r.confFp10s} | ${r.ms} ms/frame`);
        }
    }
    const R = (scene, preset) => res[`${Object.keys(scenes)[scene]}|${preset}`];
    ok('faint slow dots: Mid (adaptive) confirms most, Highest at least 10 points more', R(0, 'mid').conf >= 0.6 && R(0, 'highest').conf >= R(0, 'mid').conf + 0.1, [R(0, 'highest').conf, R(0, 'mid').conf]);
    ok('Mid and Highest both handle the mid scene (confirmed ≥ 90 %)', R(1, 'mid').conf >= 0.9 && R(1, 'highest').conf >= 0.9, [R(1, 'mid').conf, R(1, 'highest').conf]);
    ok('Low tracks large fast objects (confirmed ≥ 90 %) where Mid falls behind', R(2, 'low').conf >= 0.9 && R(2, 'low').conf > R(2, 'mid').conf, [R(2, 'low').conf, R(2, 'mid').conf]);
    ok('Low costs less than half of Mid on a 1920×1080 source', R(2, 'low').ms < R(2, 'mid').ms / 2, [R(2, 'low').ms, R(2, 'mid').ms]);
    ok('no preset confirms false detections on static hard-edged footage', Object.keys(PRESETS).every(k => R(3, k).confFp10s === 0), Object.keys(PRESETS).map(k => R(3, k).confFp10s));
    ok('no page errors', errors.length === 0, errors);
    await page.close();

    // the buttons
    const { page: p, errors: e2 } = await openApp(browser);
    await p.click('#tab-settings');
    ok('Mid is shown as active with default settings', (await p.getAttribute('#preset-mid', 'aria-pressed')) === 'true');
    await p.click('#preset-highest');
    ok('Highest sets the settings and the controls', (await p.evaluate(() => [__ph.params.sigmas, __ph.params.confirmN])).join() === '6,4'
        && (await p.inputValue('#param-sigmas')) === '6' && (await p.getAttribute('#preset-highest', 'aria-pressed')) === 'true');
    await p.fill('#param-threshold', '15');
    await p.dispatchEvent('#param-threshold', 'input');
    ok('changing a setting by hand shows Custom', (await p.evaluate(() => [...document.querySelectorAll('#presets button')].every(b => b.getAttribute('aria-pressed') === 'false')))
        && /Custom/.test(await p.textContent('#presetHint')));
    await p.click('#preset-low');
    ok('Low sets the processing width choice too', await p.isChecked('input[name=param-procWidth][value="960"]'));
    await p.reload();
    await p.waitForFunction(() => __ph.ready);
    ok('the preset\'s settings are remembered', (await p.getAttribute('#preset-low', 'aria-pressed')) === 'true');
    await p.click('#preset-mid');
    ok('no page errors (app)', e2.length === 0, e2);
    await p.close();
} finally {
    await browser.close();
}
