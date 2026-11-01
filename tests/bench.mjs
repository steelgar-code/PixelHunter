// Benchmark: detection of small low-contrast objects and false positives from camera motion,
// on fixed synthetic scenarios over several seeds. Long: not part of a full test run.
//
//   node run.mjs bench [--configs=mid,highest,mid+shift] [--scenes=A,B,…] [--seeds=2] [--jobs=3]
//                      [--save=baseline]
//
// Prints a table per scenario and config, and the change against tests/bench-baseline.json when
// it has the same scenario and config. --save=baseline writes that file. Times per frame are
// only comparable between runs with the same --jobs (parallel pages share the CPU).
//
// Metrics (over all seeds):
//   raw      share of target-frames with a candidate within 3 px
//   conf     share of target-frames with a confirmed detection within 3 px
//   lat      median frames from a target's first appearance to its first confirmed detection
//   FT/min   false tracks per minute: confirmed track ids that matched no target in most of
//            their confirmed frames (each is one false alarm)
//   FP/min   confirmed detections matching no target, per minute
//   rawFP    candidates matching no target, per frame (before confirmation: how close a scene
//            is to false alarms)
//   skip     share of frames without detection (camera motion could not be fitted): a scene
//            can look quiet only because nothing was looked at
//   fit90    median over frames of the camera-motion fit's 90th-percentile point error
//            (processing px), and the lowest coverage seen (share of grid cells with inliers)
//   ms       median pipeline time per frame (grab + camera motion + detection + tracking)
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { launch, openApp } from './lib/env.mjs';
import { sceneClip, CACHE } from './lib/clips.mjs';
import { PRESETS } from '../src/params.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const BASELINE = path.join(here, 'bench-baseline.json');
const arg = (name, def) => {
    const a = process.argv.find(x => x.startsWith(`--${name}=`));
    return a ? a.slice(name.length + 3) : def;
};

const dot = (size, contrast, fx, fy, vx, vy, extra = {}) => ({ size, contrast, fx, fy, vx, vy, ...extra });
const base = { width: 640, height: 360, noise: 2 };
// goal: 'recall' (confirmed recall ≥ 0.8) or 'quiet' (< 1 false track per minute)
export const SCENARIOS = {
    A: { what: '2×2 px, contrast 10, static camera', goal: 'recall',
        scene: seed => ({ ...base, frames: 150, camera: 'static', seed, targets: [dot(2, 10, 150, 100, 4, 1.5), dot(2, -10, 450, 250, -4, 1)] }) },
    B: { what: '2×2 px, contrast 15, handheld', goal: 'recall',
        scene: seed => ({ ...base, frames: 150, camera: 'handheld', seed, targets: [dot(2, 15, 120, 120, 3 + 4, 1), dot(2, -15, 420, 260, 3 + 3, -1.5)] }) },
    C: { what: '3×3 px, contrast 20, pan',
        scene: seed => ({ ...base, frames: 150, camera: 'pan', seed, targets: [dot(3, 20, 120, 90, 6 + 3, 2.5 + 1), dot(3, -20, 150, 250, 6 + 3.5, 2.5 - 0.5)] }) },
    'C-h264': { what: 'C through H.264 (CRF 23)', h264: 23,
        scene: seed => SCENARIOS.C.scene(seed) },
    D: { what: '3×3 px, contrast 30, strong shake',
        scene: seed => ({ ...base, frames: 150, camera: 'shake', seed, targets: [dot(3, 30, 120, 120, 3 + 4, 1), dot(3, -30, 420, 240, 3 + 3.5, -1)] }) },
    E: { what: '5×5 px, contrast 15, drone (zoom, roll, pan)',
        scene: seed => ({ ...base, frames: 150, camera: 'drone', seed, targets: [dot(5, 15, 150, 200, 4 + 3, -1.5 + 1), dot(5, -15, 420, 120, 4 + 2.5, -1.5 + 1.5)] }) },
    F: { what: 'no target, handheld over hard edges', goal: 'quiet',
        scene: seed => ({ ...base, frames: 250, camera: 'handheld', seed, shapes: 60, targets: [] }) },
    G: { what: 'no target, turning (pan + roll), hard edges', goal: 'quiet',
        scene: seed => ({ ...base, frames: 250, camera: 'turn', seed, shapes: 40, targets: [] }) },
    H: { what: 'no target, pan over trees (parallax, wind)', goal: 'quiet',
        scene: seed => ({ ...base, frames: 250, camera: 'pan', seed, targets: [], trees: trees640 }) },
    I: { what: '3×3 px, contrast 15, pan over trees',
        scene: seed => ({ ...base, frames: 150, camera: 'pan', seed, trees: trees640,
            targets: [dot(3, 15, 330, 170, 6 + 3, 2.5 + 0.8), dot(3, -15, 60, 300, 6 + 3.2, 2.5 - 1)] }) },
    J: { what: 'no target, fast yaw + lens bending 8 % + rolling shutter + motion blur', goal: 'quiet',
        scene: seed => ({ ...base, frames: 250, camera: 'yaw', seed, shapes: 40, lens: 0.08, rollingShutter: 0.6, motionBlur: 0.5, targets: [] }) },
    'J-h264': { what: 'J through H.264 (CRF 26): fast motion starves the encoder', goal: 'quiet', h264: 26,
        scene: seed => SCENARIOS.J.scene(seed) },
    'G-h264': { what: 'G through H.264 (CRF 26)', goal: 'quiet', h264: 26,
        scene: seed => SCENARIOS.G.scene(seed) },
    // compressed footage (§ noise): flat sky over textured ground, keyframes every 30 frames
    'S-h264': { what: 'no target, handheld, sky over ground, H.264 CRF 28, keyframe every 30', goal: 'quiet', h264: 28, gop: 30,
        scene: seed => ({ ...base, frames: 250, camera: 'handheld', seed, sky: { fy: 170 }, targets: [] }) },
    'S-h264-32': { what: 'S through H.264 CRF 32', goal: 'quiet', h264: 32, gop: 30,
        scene: seed => SCENARIOS['S-h264'].scene(seed) },
    'T-h264': { what: '3×3 px −20 and 2×2 px −30 in the sky, handheld, H.264 CRF 28', goal: 'recall', h264: 28, gop: 30,
        scene: seed => ({ ...base, frames: 150, camera: 'handheld', seed, sky: { fy: 170 },
            targets: [dot(3, -20, 120, 70, 3 + 3.5, 0.6), dot(2, -30, 420, 120, 3 + 2.5, -0.4)] }) },
    'C-h264-28': { what: 'C through H.264 CRF 28, keyframe every 30', h264: 28, gop: 30,
        scene: seed => SCENARIOS.C.scene(seed) },
    'F-h264': { what: 'F through H.264 CRF 28, keyframe every 30', goal: 'quiet', h264: 28, gop: 30,
        scene: seed => SCENARIOS.F.scene(seed) },
    K: { what: '1 px, contrast 25, slow (0.8 px/frame)', goal: 'recall',
        scene: seed => ({ ...base, frames: 150, camera: 'pan', seed, targets: [dot(1, 25, 200, 120, 6 + 0.8, 2.5), dot(1, -25, 380, 260, 6 - 0.6, 2.5 + 0.5)] }) },
};
const trees640 = [
    { fx: 100, fy: 80, r: 30, parallax: 0.12, sway: 1.5, swayPeriod: 37 },
    { fx: 280, fy: 250, r: 40, parallax: 0.18, sway: 2.5, swayPeriod: 29 },
    { fx: 470, fy: 110, r: 24, parallax: 0.08, sway: 3, swayPeriod: 23 },
    { fx: 550, fy: 280, r: 34, parallax: 0.15, sway: 1, swayPeriod: 41, dark: false },
];

export const CONFIGS = {
    mid: {},
    highest: PRESETS.highest.values,
    low: PRESETS.low.values,
    'mid+shift': { shiftCheck: true },
    'highest+shift': { ...PRESETS.highest.values, shiftCheck: true },
    // the tracking guards (path check, crowd gate, motion pause) off, for comparison
    'mid-noguards': { pathCheck: false, crowdGate: false, motionPause: false },
    'adaptive7-noguards': { detectMode: 'adaptive', sigmas: 7, weakMargin: 2.5, pathCheck: false, crowdGate: false, motionPause: false },
    // candidates for a Highest preset built on the adaptive detector
    h1: { detectMode: 'adaptive', sigmas: 6, weakMargin: 2 },
    h2: { detectMode: 'adaptive', sigmas: 6, weakMargin: 2, stride: 2 },
    h3: { detectMode: 'adaptive', sigmas: 6, weakMargin: 2, confirmN: 4, confirmM: 6, minTravel: 2, estWidth: 480, features: 600, holdFrames: 75 },
    adaptive: { detectMode: 'adaptive' },
    'adaptive+shift': { detectMode: 'adaptive', shiftCheck: true },
    'adaptive6': { detectMode: 'adaptive', sigmas: 6 },
    'adaptive6+shift': { detectMode: 'adaptive', sigmas: 6, shiftCheck: true },
    'adaptive7': { detectMode: 'adaptive', sigmas: 7, weakMargin: 2.5 },
    // confirmation by evidence (age + summed strength) against stricter N of M
    'mid-5of8': { confirmN: 5, confirmM: 8 },
    'mid-8of12': { confirmN: 8, confirmM: 12 },
    'mid+ev': { confirmBy: 'evidence' },
    'mid+ev-1s': { confirmBy: 'evidence', minAge: 1, minEvidence: 10 },
    'mid+ev-gap5': { confirmBy: 'evidence', maxGap: 5 },
    'highest+ev': { ...PRESETS.highest.values, confirmBy: 'evidence' },
    // slow faint targets: the Highest preset's stride and confirmation with the adaptive detector
    'adaptive-slow': { ...PRESETS.highest.values, detectMode: 'adaptive', sigmas: 6 },
};

const configs = arg('configs', 'mid,highest,mid+shift').split(',');
const scenes = arg('scenes', Object.keys(SCENARIOS).join(',')).split(',');
const seeds = Array.from({ length: Number(arg('seeds', 2)) }, (_, i) => 101 + i);
const jobs = Math.max(1, Number(arg('jobs', 3)));
const save = arg('save', null);
// --extra='{"key":value}': added to every config (for trying a setting across the board)
const extra = JSON.parse(arg('extra', '{}'));
for (const c of configs) if (!CONFIGS[c]) throw new Error(`unknown config ${c} (${Object.keys(CONFIGS).join(', ')})`);
for (const s of scenes) if (!SCENARIOS[s]) throw new Error(`unknown scenario ${s}`);

// Runs in the page: one scene (synthetic, or raw grey frames from a URL) through a pipeline.
async function runInPage({ scene, raw, params }) {
    const { createScene, greyToRgba } = await import('/src/synth.js');
    const { createPipeline } = await import('/src/pipeline.js');
    const { matchFrame } = await import('/src/score.js');
    let frames, W, H, frameAt, fps = 25;
    if (raw) {
        const buf = new Uint8Array(await (await fetch(raw.url)).arrayBuffer());
        W = raw.width; H = raw.height; frames = Math.min(raw.truth.length, Math.floor(buf.length / (W * H)));
        frameAt = k => ({ grey: buf.subarray(k * W * H, (k + 1) * W * H), truth: raw.truth[k] });
    } else {
        const s = createScene(scene);
        W = s.width; H = s.height; frames = s.frames; fps = s.fps;
        frameAt = k => s.frame(k);
    }
    const pipe = createPipeline(cv, { ...window.__ph.params, mode: 'everyFrame', ...params });
    let tf = 0, tp = 0, ctp = 0, fpConf = 0, shown = 0, skipped = 0, rawFp = 0, detected = 0;
    const firstSeen = {}, firstConf = {}, tracks = {}, ms = [], fit90 = [];
    let minCover = 1;
    let rgba = null;
    for (let k = 0; k < frames; k++) {
        const f = frameAt(k);
        rgba = greyToRgba(f.grey, rgba || undefined);
        const r = pipe.push({ imageData: new ImageData(rgba, W, H), width: W, height: H, time: k / fps, frame: k, seq: k, gap: 0,
            jump: k === 0, jumpReason: k === 0 ? 'start' : null, truth: f.truth }).result;
        if (!r) continue;
        ms.push(r.timings.total);
        shown++;
        if (r.fit) { fit90.push(r.fit.err90); minCover = Math.min(minCover, r.fit.coverage); }
        if (!r.detect.ok && k > 2 * (params.stride || 1) + 1) skipped++;
        const sc = r.scale;
        const truth = r.truth.targets.map(t => ({ ...t, cx: (t.cx + 0.5) * sc - 0.5, cy: (t.cy + 0.5) * sc - 0.5 }));
        for (const t of truth) firstSeen[t.id] ??= r.frame;
        tf += truth.length;
        if (r.detect.ok) {
            const mr = matchFrame(r.candidates, truth);
            tp += mr.tp;
            rawFp += mr.fp;
            detected++;
        }
        const m = matchFrame(r.confirmed.map(t => t.box), truth);
        ctp += m.tp;
        fpConf += m.fp;
        const matched = new Set(m.matches.map(x => x.detection));
        r.confirmed.forEach((t, i) => {
            const e = tracks[t.id] ??= { n: 0, hit: 0 };
            e.n++;
            if (matched.has(i)) e.hit++;
        });
        for (const x of m.matches) firstConf[x.target] ??= r.frame;
    }
    pipe.dispose();
    ms.sort((a, b) => a - b);
    fit90.sort((a, b) => a - b);
    const lat = Object.keys(firstSeen).map(id => (id in firstConf ? firstConf[id] - firstSeen[id] : null));
    return { frames, fps, tf, tp, ctp, fpConf, skip: shown ? skipped / shown : 0, rawFp: detected ? rawFp / detected : 0,
        fit90: fit90.length ? fit90[fit90.length >> 1] : null, minCover, falseTracks: Object.values(tracks).filter(e => e.hit < e.n / 2).length,
        lat, ms: ms.length ? ms[ms.length >> 1] : null };
}

// H.264 version of a scene, decoded to raw grey frames the page can fetch.
async function rawClip(scene, crf, gop) {
    const clip = await sceneClip(scene, { crf, gop });
    const out = `${clip.path}.gray`;
    if (!fs.existsSync(out)) {
        const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', clip.path, '-f', 'rawvideo', '-pix_fmt', 'gray', out]);
        if (r.status !== 0) throw new Error(`ffmpeg decode failed: ${r.stderr}`);
    }
    return { url: `tests/.cache/${path.basename(out)}`, width: scene.width, height: scene.height, truth: clip.truth };
}

const browser = await launch();
const pages = [];
for (let i = 0; i < jobs; i++) {
    const { page, errors } = await openApp(browser);
    pages.push({ page, errors });
}
const work = [];
for (const s of scenes) for (const c of configs) for (const seed of seeds) work.push({ s, c, seed });
const results = {};
let next = 0;
const t0 = Date.now();
await Promise.all(pages.map(async ({ page }) => {
    while (next < work.length) {
        const w = work[next++];
        const sc = SCENARIOS[w.s];
        const scene = sc.scene(w.seed);
        const params = { ...CONFIGS[w.c], ...extra };
        const spec = sc.h264 ? { raw: await rawClip(scene, sc.h264, sc.gop), params } : { scene, params };
        if (spec.raw) spec.raw.url = new URL(spec.raw.url, page.url()).href;
        const r = await page.evaluate(runInPage, spec);
        (results[`${w.s}|${w.c}`] ??= []).push(r);
    }
}));
await browser.close();

// summary per scenario × config
const summary = {};
for (const [key, runs] of Object.entries(results)) {
    const sum = f => runs.reduce((a, r) => a + f(r), 0);
    const minutes = sum(r => r.frames / r.fps) / 60;
    const tf = sum(r => r.tf);
    const lat = runs.flatMap(r => r.lat);
    const found = lat.filter(v => v !== null).sort((a, b) => a - b);
    summary[key] = {
        raw: tf ? sum(r => r.tp) / tf : null,
        conf: tf ? sum(r => r.ctp) / tf : null,
        lat: lat.length ? (found.length ? found[found.length >> 1] : null) : undefined,
        missedTargets: lat.filter(v => v === null).length,
        ftPerMin: sum(r => r.falseTracks) / minutes,
        fpPerMin: sum(r => r.fpConf) / minutes,
        ms: runs.map(r => r.ms).sort((a, b) => a - b)[runs.length >> 1],
        skip: sum(r => r.skip) / runs.length,
        rawFp: sum(r => r.rawFp) / runs.length,
        fit90: runs.map(r => r.fit90).sort((a, b) => a - b)[runs.length >> 1],
        minCover: Math.min(...runs.map(r => r.minCover)),
    };
}
const baseline = fs.existsSync(BASELINE) ? JSON.parse(fs.readFileSync(BASELINE, 'utf8')) : null;
const pct = v => (v === null || v === undefined ? '   –' : `${Math.round(v * 100)}%`.padStart(4));
const num = (v, d = 1) => (v === null || v === undefined ? '–' : v.toFixed(d));
const delta = (v, b, scale = 100, unit = '') => {
    if (v === null || v === undefined || b === null || b === undefined) return '';
    const d = (v - b) * scale;
    return Math.abs(d) < 0.5 ? '' : ` (${d > 0 ? '+' : ''}${d.toFixed(0)}${unit})`;
};
console.log(`\nBenchmark${Object.keys(extra).length ? ` with ${JSON.stringify(extra)}` : ''}: ${seeds.length} seed(s), ${jobs} job(s), ${((Date.now() - t0) / 1000).toFixed(0)} s${baseline ? `; changes against the baseline of ${baseline.created}` : ''}`);
for (const s of scenes) {
    const sc = SCENARIOS[s];
    console.log(`\n${s}  ${sc.what}${sc.goal === 'recall' ? '   [goal: confirmed ≥ 80 %]' : sc.goal === 'quiet' ? '   [goal: < 1 false track / min]' : ''}`);
    for (const c of configs) {
        const r = summary[`${s}|${c}`], b = baseline && baseline.summary[`${s}|${c}`];
        const met = sc.goal === 'recall' ? r.conf >= 0.8 : sc.goal === 'quiet' ? r.ftPerMin < 1 : null;
        const parts = [
            r.raw === null ? '' : `raw ${pct(r.raw)}${delta(r.raw, b && b.raw)}`,
            r.conf === null ? '' : `conf ${pct(r.conf)}${delta(r.conf, b && b.conf)}`,
            r.lat === undefined ? '' : `lat ${r.lat === null ? '–' : r.lat}${r.missedTargets ? ` (${r.missedTargets} never)` : ''}`,
            `FT/min ${num(r.ftPerMin)}${b ? delta(r.ftPerMin, b.ftPerMin, 1) : ''}`,
            `FP/min ${num(r.fpPerMin, 0)}`,
            `rawFP ${num(r.rawFp, 2)}`,
            r.skip >= 0.005 ? `skip ${pct(r.skip)}` : '',
            r.fit90 === null || r.fit90 === undefined ? '' : `fit90 ${num(r.fit90, 2)} px (cover ≥ ${pct(r.minCover).trim()})`,
            `${num(r.ms, 0)} ms`,
        ].filter(Boolean);
        console.log(`  ${c.padEnd(14)} ${parts.join('  ')}${met === null ? '' : met ? '   ✓' : '   ✗'}`);
    }
}
const out = { created: new Date().toISOString(), seeds, jobs, configs, summary };
fs.mkdirSync(CACHE, { recursive: true });
fs.writeFileSync(path.join(CACHE, 'bench-last.json'), JSON.stringify(out, null, 1));
if (save === 'baseline') {
    const merged = baseline ? { ...out, summary: { ...baseline.summary, ...summary } } : out;
    fs.writeFileSync(BASELINE, JSON.stringify(merged, null, 1));
    console.log(`\nSaved as the baseline (${path.relative(process.cwd(), BASELINE)}).`);
}
