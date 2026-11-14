// Benchmark: detection of small low-contrast objects and false positives from camera motion,
// on fixed synthetic scenarios over several seeds. Long: not part of a full test run.
//
//   node run.mjs bench [--configs=mid,highest,mid+shift] [--scenes=A,B,…] [--seeds=2] [--jobs=3]
//                      [--save=baseline]
//
// A config name may end in @rt2 or @rt3 ("as in real time"): only every 2nd (3rd) frame is pushed,
// with `gap` set, as the frame loop does when it drops frames (not stride 2, which still steps the
// tracker every frame). The ground scenarios (g-…) are meant to be read with and without it.
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
//   lane     with the slow lane on: its own raw recall and raw false candidates per pass, against
//            the truth of the frame it looked at (u, older than the frame shown); raw / rawFP
//            above are the fast lane's only, confirmed numbers both lanes'
//   (far scenarios also print "once found": per target, confirmed recall within 3 px counted from
//   its first confirmed frame on, so a long latency is not counted twice; `foundRecall` in perTarget)
//   tpt      tracks per target: confirmed track ids that were on a target in most of their
//            frames, per target seen (1 = one track per object; leading and trailing edges of a
//            large object give 2). A track is "on" the nearest target within the match radius,
//            not one-to-one, so a second track on the same object is not a false track.
//
// Far scenarios (far-…, matrix: true; batch 3): nine small faint slow targets (sizes 1, 2, 3 px ×
// contrasts 8, 12, 20) at one speed, counted per target: for every config a grid (rows = size,
// columns = contrast) of "confirmed recall within 3 px / within 6 px (latency in frames)", over
// all seeds, counted from each target's first frame in view; the latency is the median over the
// seeds that found it ("–": never). Saved under `perTarget` in the summary. The 6 px figure tells
// "found, but shown a few px off" (compression does that) from "not found". Their empty twins
// (far-quiet…, goal 'quiet') are read with --seeds=6.
//
// Ground scenarios (g-…, ground: true; batch 2): target velocities are their own, against the
// ground (own()); a target larger than 3 px matches within half its size + 3 px (3 px otherwise,
// as everywhere else); false tracks are tracks on no target in most of their frames (the
// non-exclusive rule of tpt); frames in a target's stops do not count for recall ("recall while
// moving"). The older scenarios keep their rules, so their numbers stay comparable.
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
// A target by its own velocity against the ground (px a frame), for the ground scenarios. (The
// older scenarios write the camera's drift plus a little, which is slow on the screen and 6–10 px
// a frame against the ground.) extra: { w, h } for a rectangle, stops, from / to.
const own = (size, contrast, fx, fy, vx, vy, extra = {}) => ({ size, contrast, fx, fy, vx, vy, ...extra });
const base = { width: 640, height: 360, noise: 2 };
// slow objects need a longer clip: the slow lane's first pass comes after 2 × 12 frames
const ground = { ...base, frames: 300 };
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
    // sky over ground, not compressed: sensor noise is all the sky has for the camera-motion fit
    U: { what: '3×3 px −20 and 2×2 px −30 in the sky, handheld, sky over ground', goal: 'recall',
        scene: seed => SCENARIOS['T-h264'].scene(seed) },
    V: { what: 'no target, handheld, sky over ground', goal: 'quiet',
        scene: seed => SCENARIOS['S-h264'].scene(seed) },
    // the ground only in the bottom sixth of the frame, a camera turning on a gimbal
    W: { what: '3×3 px −20 and 2×2 px +25 in the sky, wide lens (60°) sweeping at up to 12.5°/s, ground in the bottom sixth', goal: 'recall',
        scene: seed => ({ ...base, frames: 150, camera: 'gimbal', seed, sky: { fy: 300 }, targets: [dot(3, -20, 120, 90, 3, 0.5), dot(2, 25, 200, 200, 3.4, -0.4)] }) },
    X: { what: 'W through a long lens (10°)', goal: 'recall',
        scene: seed => ({ ...base, frames: 150, camera: 'tele', seed, sky: { fy: 300 }, targets: [dot(3, -20, 100, 90, 6.2 + 3, 0.5), dot(2, 25, 60, 200, 6.2 + 3.5, -0.4)] }) },
    Y: { what: 'no target, long lens panning, ground in the bottom sixth', goal: 'quiet',
        scene: seed => ({ ...base, frames: 250, camera: 'tele', seed, sky: { fy: 300 }, shapes: 30, targets: [] }) },
    K: { what: '1 px, contrast 25, slow (0.8 px/frame)', goal: 'recall',
        scene: seed => ({ ...base, frames: 150, camera: 'pan', seed, targets: [dot(1, 25, 200, 120, 6 + 0.8, 2.5), dot(1, -25, 380, 260, 6 - 0.6, 2.5 + 0.5)] }) },

    // --- ground views (batch 2): speeds are the objects' own, against the ground ---
    'g-fix-0.2': { what: 'fixed camera (tripod), 3×3 px contrast 20 at 0.2 px a frame', goal: 'recall', ground: true,
        scene: seed => ({ ...ground, camera: 'tripod', seed, targets: [own(3, 20, 200, 120, 0.2, 0.06), own(3, -20, 440, 240, -0.2, -0.06)] }) },
    'g-fix-0.5': { what: 'fixed camera (tripod), 3×3 px contrast 20 at 0.5 px a frame', goal: 'recall', ground: true,
        scene: seed => ({ ...ground, camera: 'tripod', seed, targets: [own(3, 20, 160, 120, 0.5, 0.15), own(3, -20, 480, 240, -0.5, -0.15)] }) },
    'g-hover-0.5': { what: 'hovering drone, 3×3 px contrast 20 at 0.5 px a frame', ground: true,
        scene: seed => ({ ...ground, camera: 'hover', seed, targets: [own(3, 20, 160, 120, 0.5, 0.15), own(3, -20, 480, 240, -0.5, -0.15)] }) },
    'g-hover-1': { what: 'hovering drone, 3×3 px contrast 20 at 1 px a frame', ground: true,
        scene: seed => ({ ...ground, camera: 'hover', seed, targets: [own(3, 20, 100, 100, 1, 0.3), own(3, -20, 540, 260, -1, -0.3)] }) },
    'g-hand-1': { what: 'handheld (drift 3 px a frame), 3×3 px contrast 20 at 1 px a frame', ground: true,
        scene: seed => ({ ...base, frames: 150, camera: 'handheld', seed, targets: [own(3, 20, 560, 120, 1, 0.3), own(3, -20, 600, 240, -1, -0.3)] }) },
    'g-trees': { what: 'no target, fixed camera (tripod), wind in trees', goal: 'quiet', ground: true,
        scene: seed => ({ ...ground, camera: 'tripod', seed, targets: [], trees: trees640 }) },
    'g-hover-trees': { what: 'no target, hovering drone over trees (parallax, wind)', goal: 'quiet', ground: true,
        scene: seed => ({ ...ground, camera: 'hover', seed, targets: [], trees: trees640 }) },
    'g-people': { what: 'fixed camera, a "person" 3×8 px contrast −25 at 0.4 and a "vehicle" 8×4 px contrast 30 at 1.5 px a frame', goal: 'recall', ground: true,
        scene: seed => ({ ...ground, camera: 'tripod', seed, targets: [own(3, -25, 150, 250, 0.4, -0.1, { w: 3, h: 8 }), own(8, 30, 80, 110, 1.5, 0.2, { w: 8, h: 4 })] }) },
    'g-stopgo': { what: 'fixed camera, 3×3 px contrast 25 at 2 px a frame, stops for 2 s (frames 100–150) and goes on', goal: 'recall', ground: true,
        scene: seed => ({ ...ground, camera: 'tripod', seed, targets: [own(3, 25, 60, 120, 2, 0.5, { stops: [[100, 150]] })] }) },
    'g-large': { what: 'fixed camera, 12×12 px contrast 25 and 20×20 px contrast −25 at 2 px a frame', goal: 'recall', ground: true,
        scene: seed => ({ ...base, frames: 150, camera: 'tripod', seed, targets: [own(12, 25, 120, 110, 2, 0.5), own(20, -25, 160, 260, 2, -0.3)] }) },
    // (at 2 px a frame a plain object this large hardly shows between neighbouring frames: its
    // inside does not change; at 5 px its leading and trailing edges do, as two tracks)
    'g-large-5': { what: 'fixed camera, 12×12 px contrast 25 and 20×20 px contrast −25 at 5 px a frame', goal: 'recall', ground: true,
        scene: seed => ({ ...base, frames: 100, camera: 'tripod', seed, targets: [own(12, 25, 60, 110, 5, 0.5), own(20, -25, 80, 260, 5, -0.3)] }) },
};

// --- far, small, slow objects on the ground (batch 3) ---
// nine targets at one speed v (px a frame, against the ground): rows by size, columns by contrast,
// sign alternating (as in tools/far.mjs)
const FAR_SIZES = [1, 2, 3], FAR_CONTRASTS = [8, 12, 20];
const farTargets = v => FAR_SIZES.flatMap((size, r) => FAR_CONTRASTS.map((c, q) =>
    own(size, ((r + q) % 2 ? -1 : 1) * c, 110 + 200 * q, 70 + 110 * r, v, 0.3 * v * (r % 2 ? -1 : 1))));
const farScene = (v, frames, camera) => seed => ({ ...base, frames, camera, seed, targets: farTargets(v) });
const farQuiet = (frames, camera) => seed => ({ ...base, frames, camera, seed, targets: [] });
const far = (what, v, frames, camera, extra = {}) => ({ what: `${what}: nine targets (1–3 px × contrast 8–20) at ${v} px a frame`, goal: 'recall', ground: true, matrix: true, speed: v, ...extra, scene: farScene(v, frames, camera) });
Object.assign(SCENARIOS, {
    'far-0.03': far('tripod', 0.03, 500, 'tripod'),
    'far-0.05': far('tripod', 0.05, 500, 'tripod'),
    'far-0.1': far('tripod', 0.1, 400, 'tripod'),
    'far-0.2': far('tripod', 0.2, 300, 'tripod'),
    'far-0.5': far('tripod', 0.5, 220, 'tripod'),
    'far-hover-0.1': far('hovering camera', 0.1, 400, 'hover'),
    'far-hover-0.2': far('hovering camera', 0.2, 300, 'hover'),
    'far-0.2-crf23': far('tripod, H.264 CRF 23, keyframe every 30', 0.2, 300, 'tripod', { h264: 23, gop: 30 }),
    'far-0.2-crf28': far('tripod, H.264 CRF 28, keyframe every 30', 0.2, 300, 'tripod', { h264: 28, gop: 30 }),
    'far-0.5-crf23': far('tripod, H.264 CRF 23, keyframe every 30', 0.5, 220, 'tripod', { h264: 23, gop: 30 }),
    'far-0.5-crf28': far('tripod, H.264 CRF 28, keyframe every 30', 0.5, 220, 'tripod', { h264: 28, gop: 30 }),
    'far-0.2-crf23-g60': far('tripod, H.264 CRF 23, keyframe every 60', 0.2, 300, 'tripod', { h264: 23, gop: 60 }),
    // empty twins (read with --seeds=6)
    'far-quiet': { what: 'no target, tripod, 500 frames (twin of far-…)', goal: 'quiet', ground: true, scene: farQuiet(500, 'tripod') },
    'far-quiet-hover': { what: 'no target, hovering camera, 500 frames', goal: 'quiet', ground: true, scene: farQuiet(500, 'hover') },
    'far-quiet-crf23': { what: 'no target, tripod, H.264 CRF 23, keyframe every 30', goal: 'quiet', ground: true, h264: 23, gop: 30, scene: farQuiet(500, 'tripod') },
    'far-quiet-crf28': { what: 'no target, tripod, H.264 CRF 28, keyframe every 30', goal: 'quiet', ground: true, h264: 28, gop: 30, scene: farQuiet(500, 'tripod') },
    'far-quiet-crf23-g60': { what: 'no target, tripod, H.264 CRF 23, keyframe every 60', goal: 'quiet', ground: true, h264: 23, gop: 60, scene: farQuiet(500, 'tripod') },
});
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
    compressed: PRESETS.compressed.values,
    'mid+shift': { shiftCheck: true },
    // the slow lane (batch 2)
    // (on by default since 0.14.0: mid+slow equals mid; mid-slow is Mid without the lane, as Mid was until 0.13.0)
    'mid+slow': { slow: true },
    'mid-slow': { slow: false },
    'highest-slow': { ...PRESETS.highest.values, slow: false },
    // the border margin along the frame's own edges (default since 0.13.0): mid-0.12 is Mid without
    // it, as 0.12.0 (on a tripod nearly all of 0.12.0's candidates were in the outermost 1–2 px)
    'mid+edge': { edgeMargin: true, slow: false },
    'mid-0.12': { edgeMargin: false, slow: false },
    'highest-0.12': { ...PRESETS.highest.values, edgeMargin: false, slow: false },
    'mid+slow+edge': { slow: true, edgeMargin: true },
    // how the slow lane's tracks are carried to the displayed frame (batch 3): 0 the α-β filter's
    // velocity (0.14.0), 1 the velocity of the path fitted to the recent sightings (default since 0.15.0), 2 also its place
    'mid+fit0': { slowFitCarry: 0 }, 'mid+fit1': { slowFitCarry: 1 }, 'mid+fit2': { slowFitCarry: 2 },
    'highest+fit0': { ...PRESETS.highest.values, slowFitCarry: 0 }, 'highest+fit2': { ...PRESETS.highest.values, slowFitCarry: 2 },
    'highest+slow': { ...PRESETS.highest.values, slow: true },
    // the camera-motion fit as before 0.12.0 (every point that agrees, always the full fit, LK
    // window 21), for comparison: gives the numbers of 0.11.0
    'mid-0.11': { precise: false, thinFit: false, lkWin: 21 },
    'highest-0.11': { ...PRESETS.highest.values, precise: false, thinFit: false, lkWin: 21 },
    // the detector's allowance from the fit's misfit instead of its points' scatter (with the
    // higher floor it needs): more of the faintest objects, more raw candidates at hard edges
    'mid+misfit': { fitErrFrom: 'misfit', tolBase: 0.10 },
    'highest+misfit': { ...PRESETS.highest.values, fitErrFrom: 'misfit', tolBase: 0.10 },
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
    // compressed footage: a floor for the patch sums (minMean) against a higher min contrast
    'mid+mean2': { minMean: 2 },
    'mid+mean3': { minMean: 3 },
    'mid+mc8': { minContrast: 8 },
    'mid+mc10': { minContrast: 10 },
    'mid+mean3+mc6': { minMean: 3, minContrast: 6 },
    'highest+mean3': { ...PRESETS.highest.values, minMean: 3 },
    'mid+mean0': { minMean: 0 },
    // confirmation options (2026-11-02 batch)
    'mid+strong2': { minStrong: 2 },
    'mid+spatial4': { minSpatial: 4 },
    'mid+time': { confirmBy: 'time' },
    'mid+near2': { nearMargin: 2 },
    'highest+near2': { ...PRESETS.highest.values, nearMargin: 2 },
    // candidates for a Compressed preset
    comp1: { minMean: 3, confirmBy: 'evidence' },
    comp2: { minMean: 3, minContrast: 8, confirmBy: 'evidence' },
    comp3: { minMean: 3, minContrast: 8, confirmN: 4, confirmM: 6 },
    comp4: { minMean: 3, minContrast: 8, sigmas: 8, minArea: 2, confirmBy: 'evidence' },
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
// 'mid@rt2': config mid, every 2nd frame pushed (as in real time when frames are dropped)
const configOf = c => c.split('@')[0];
const everyOf = c => { const m = /@rt(\d+)$/.exec(c); return m ? Number(m[1]) : 1; };
for (const c of configs) if (!CONFIGS[configOf(c)] || (c.includes('@') && !/@rt\d+$/.test(c))) throw new Error(`unknown config ${c} (${Object.keys(CONFIGS).join(', ')}; @rt2 / @rt3 after a name: every 2nd / 3rd frame)`);
for (const s of scenes) if (!SCENARIOS[s]) throw new Error(`unknown scenario ${s}`);

// Runs in the page: one scene (synthetic, or raw grey frames from a URL) through a pipeline.
async function runInPage({ scene, raw, params, every = 1, ground = false, stops = [], matrix = false }) {
    const { createScene, greyToRgba } = await import('/src/synth.js');
    const { createPipeline } = await import('/src/pipeline.js');
    const { matchFrame } = await import('/src/score.js');
    let frames, W, H, frameAt, truthAt, fps = 25;
    if (raw) {
        const buf = new Uint8Array(await (await fetch(raw.url)).arrayBuffer());
        W = raw.width; H = raw.height; frames = Math.min(raw.truth.length, Math.floor(buf.length / (W * H)));
        frameAt = k => ({ grey: buf.subarray(k * W * H, (k + 1) * W * H), truth: raw.truth[k] });
        truthAt = k => raw.truth[k];
    } else {
        const s = createScene(scene);
        W = s.width; H = s.height; frames = s.frames; fps = s.fps;
        frameAt = k => s.frame(k);
        truthAt = k => s.truth(k);
    }
    const pipe = createPipeline(cv, { ...window.__ph.params, mode: 'everyFrame', ...params });
    let tf = 0, tp = 0, ctp = 0, fpConf = 0, shown = 0, skipped = 0, rawFp = 0, detected = 0;
    const firstSeen = {}, firstConf = {}, tracks = {}, ms = [], fit90 = [];
    let minCover = 1;
    let rgba = null;
    // ground scenarios: a target larger than 3 px matches within half its size + 3 px
    const radius = t => (ground && Math.max(t.w, t.h) > 3 ? Math.max(t.w, t.h) / 2 + 3 : 3);
    const R = ground ? 13 : 3;          // matchFrame's outer radius; each pair is checked against radius(t) below
    const match = (dets, truth) => {
        const m = matchFrame(dets, truth, R);
        if (!ground) return m;
        const byId = Object.fromEntries(truth.map(t => [t.id, t]));
        const kept = m.matches.filter(x => x.dist <= radius(byId[x.target]));
        return { tp: kept.length, fp: dets.length - kept.length, matches: kept };
    };
    // the nearest target within its radius, not one-to-one (tracks per target)
    const nearest = (b, truth) => {
        let best = null;
        for (const t of truth) { const d = Math.hypot(b.cx - t.cx, b.cy - t.cy); if (d <= radius(t) && (!best || d < best.d)) best = { id: t.id, d }; }
        return best && best.id;
    };
    const stopped = (id, k) => (stops[id] || []).some(([a, b]) => k >= a && k <= b);
    const seenTargets = new Set();
    const per = {};     // matrix scenarios: per target { n, hit3, hit6, first, firstConf }
    let laneTf = 0, laneTp = 0, laneFp = 0, passes = 0;
    for (let k = 0; k < frames; k++) {
        // as in real time: frames not pushed are dropped ones (the next one carries the gap)
        if (k % every) continue;
        const f = frameAt(k);
        rgba = greyToRgba(f.grey, rgba || undefined);
        const r = pipe.push({ imageData: new ImageData(rgba, W, H), width: W, height: H, time: k / fps, frame: k, seq: k / every, gap: k ? every - 1 : 0,
            jump: k === 0, jumpReason: k === 0 ? 'start' : null, truth: f.truth }).result;
        if (!r) continue;
        ms.push(r.timings.total);
        shown++;
        if (r.fit) { fit90.push(r.fit.err90); minCover = Math.min(minCover, r.fit.coverage); }
        if (!r.detect.ok && k > 2 * (params.stride || 1) * every + 1) skipped++;
        const sc = r.scale;
        const all = r.truth.targets.map(t => ({ ...t, cx: (t.cx + 0.5) * sc - 0.5, cy: (t.cy + 0.5) * sc - 0.5, w: t.w * sc, h: t.h * sc }));
        for (const t of all) { firstSeen[t.id] ??= r.frame; seenTargets.add(t.id); }
        // recall while moving: a target standing still does not count
        const truth = all.filter(t => !stopped(t.id, r.frame));
        tf += truth.length;
        if (r.detect.ok) {
            const mr = match(r.candidates, truth);
            tp += mr.tp;
            rawFp += mr.fp;
            detected++;
        }
        // the slow lane's own candidates, on the frame it looked at
        if (r.slow && r.slow.state === 'pass' && r.slow.list) {
            passes++;
            const tu = truthAt(r.slow.frame).targets.map(t => ({ ...t, cx: (t.cx + 0.5) * sc - 0.5, cy: (t.cy + 0.5) * sc - 0.5, w: t.w * sc, h: t.h * sc }))
                .filter(t => !stopped(t.id, r.slow.frame));
            const ml = match(r.slow.list, tu);
            laneTf += tu.length; laneTp += ml.tp; laneFp += ml.fp;
        }
        const m = match(r.confirmed.map(t => t.box), truth);
        ctp += m.tp;
        fpConf += m.fp;
        const matched = new Set(m.matches.map(x => x.detection));
        r.confirmed.forEach((t, i) => {
            const e = tracks[t.id] ??= { n: 0, hit: 0, on: {} };
            e.n++;
            if (matched.has(i)) e.hit++;
            const id = nearest(t.box, all);
            if (id !== null) e.on[id] = (e.on[id] || 0) + 1;
        });
        for (const x of m.matches) firstConf[x.target] ??= r.frame;
        if (matrix) {
            const hit3 = new Set(m.matches.map(x => x.target));
            for (const t of truth) {
                const e = per[t.id] ??= { n: 0, hit3: 0, hit6: 0, first: r.frame, firstConf: null, nf: 0, hitF: 0 };
                e.n++;
                const near3 = hit3.has(t.id);
                if (near3) { e.hit3++; e.firstConf ??= r.frame; }
                // recall once found: from the first confirmed frame on
                if (e.firstConf !== null) { e.nf++; if (near3) e.hitF++; }
                if (near3 || r.confirmed.some(c => Math.hypot(c.box.cx - t.cx, c.box.cy - t.cy) <= 6)) e.hit6++;
            }
        }
    }
    pipe.dispose();
    ms.sort((a, b) => a - b);
    fit90.sort((a, b) => a - b);
    const lat = Object.keys(firstSeen).map(id => (id in firstConf ? firstConf[id] - firstSeen[id] : null));
    const onTarget = e => Object.values(e.on).some(n => n >= e.n / 2);
    const list = Object.values(tracks);
    return { frames, fps, tf, tp, ctp, fpConf, skip: shown ? skipped / shown : 0, rawFp: detected ? rawFp / detected : 0,
        fit90: fit90.length ? fit90[fit90.length >> 1] : null, minCover,
        falseTracks: ground ? list.filter(e => !onTarget(e)).length : list.filter(e => e.hit < e.n / 2).length,
        targetTracks: list.filter(onTarget).length, targets: seenTargets.size, processed: shown, laneTf, laneTp, laneFp, passes,
        lat, per, ms: ms.length ? ms[ms.length >> 1] : null };
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
        const params = { ...CONFIGS[configOf(w.c)], ...extra };
        const opts = { every: everyOf(w.c), ground: !!sc.ground, matrix: !!sc.matrix, stops: Object.fromEntries(scene.targets.map((t, i) => [i, t.stops || []])) };
        const spec = sc.h264 ? { raw: await rawClip(scene, sc.h264, sc.gop), params, ...opts } : { scene, params, ...opts };
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
        tracksPerTarget: sum(r => r.targets) ? sum(r => r.targetTracks) / sum(r => r.targets) : null,
        processed: sum(r => r.processed) / sum(r => r.frames),
        laneRaw: sum(r => r.passes || 0) ? (sum(r => r.laneTf) ? sum(r => r.laneTp) / sum(r => r.laneTf) : null) : undefined,
        laneRawFp: sum(r => r.passes || 0) ? sum(r => r.laneFp) / sum(r => r.passes) : undefined,
    };
    const sc = SCENARIOS[key.split('|')[0]];
    if (sc.matrix) {
        // per target over all seeds (the layout is the same in every seed)
        const targets = sc.scene(seeds[0]).targets;
        summary[key].perTarget = targets.map((t, i) => {
            const es = runs.map(r => r.per[i]).filter(Boolean);
            const lats = es.filter(e => e.firstConf !== null).map(e => e.firstConf - e.first).sort((a, b) => a - b);
            const n = es.reduce((a, e) => a + e.n, 0);
            return { size: t.size, contrast: t.contrast, n, hit3: es.reduce((a, e) => a + e.hit3, 0), hit6: es.reduce((a, e) => a + e.hit6, 0),
                recall3: n ? es.reduce((a, e) => a + e.hit3, 0) / n : null, recall6: n ? es.reduce((a, e) => a + e.hit6, 0) / n : null,
                lat: lats.length ? lats[lats.length >> 1] : null, found: lats.length, seeds: es.length,
                // recall within 3 px from the first confirmed frame on (over the seeds that found it)
                foundRecall: es.reduce((a, e) => a + (e.nf || 0), 0) ? es.reduce((a, e) => a + (e.hitF || 0), 0) / es.reduce((a, e) => a + (e.nf || 0), 0) : null };
        });
    }
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
            sc.ground && r.tracksPerTarget !== null ? `tpt ${num(r.tracksPerTarget, 2)}` : '',
            r.laneRawFp !== undefined ? `lane raw ${r.laneRaw === null ? '–' : pct(r.laneRaw).trim()} FP ${num(r.laneRawFp, 2)}` : '',
            `FP/min ${num(r.fpPerMin, 0)}`,
            `rawFP ${num(r.rawFp, 2)}`,
            r.skip >= 0.005 ? `skip ${pct(r.skip)}` : '',
            r.fit90 === null || r.fit90 === undefined ? '' : `fit90 ${num(r.fit90, 2)} px (cover ≥ ${pct(r.minCover).trim()})`,
            `${num(r.ms, 0)} ms`,
        ].filter(Boolean);
        console.log(`  ${c.padEnd(14)} ${parts.join('  ')}${met === null ? '' : met ? '   ✓' : '   ✗'}`);
        if (r.perTarget) {
            // rows = size, columns = contrast: recall within 3 px / within 6 px (latency in frames)
            const cell = e => `${e.n ? Math.round(e.recall3 * 100) : '–'} / ${e.n ? Math.round(e.recall6 * 100) : '–'} (${e.lat === null ? '–' : e.lat})`.padEnd(17);
            console.log(`  ${''.padEnd(14)} contrast   ${FAR_CONTRASTS.map(x => `${x}`.padEnd(17)).join('')}  (recall 3 px / 6 px (latency in frames); sign alternates)`);
            FAR_SIZES.forEach((size, row) => console.log(`  ${''.padEnd(14)} ${`${size} px:`.padEnd(10)} ${r.perTarget.slice(3 * row, 3 * row + 3).map(cell).join('')}`));
            // recall once found (within 3 px, from the first confirmed frame on): latency not counted twice
            const fcell = e => `${e.foundRecall === null || e.foundRecall === undefined ? '–' : Math.round(e.foundRecall * 100)}`.padEnd(17);
            console.log(`  ${''.padEnd(14)} once found ${FAR_CONTRASTS.map(x => `${x}`.padEnd(17)).join('')}  (recall 3 px from the first confirmed frame on, %)`);
            FAR_SIZES.forEach((size, row) => console.log(`  ${''.padEnd(14)} ${`${size} px:`.padEnd(10)} ${r.perTarget.slice(3 * row, 3 * row + 3).map(fcell).join('')}`));
        }
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
