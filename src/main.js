// Wiring: OpenCV.js startup check, sources, frame loop, parameter controls and stats.
import { loadCv, checkCv, CV_VERSION } from './cvLoader.js';
import { fileSource } from './sources.js';
import { createFrameLoop } from './frameLoop.js';
import { createSyntheticLoop } from './synthLoop.js';
import { createScene } from './synth.js';
import { SCENES } from './scenes.js';
import { PARAM_DEFS, resolveParams, parseHash, loadSaved, save } from './params.js';
import { createPipeline } from './pipeline.js';
import { createScore } from './score.js';
import { createExportLog, download } from './exportLog.js';
import { fitOverlay, clear, drawPoints, drawNote, drawBoxes, drawTruth, drawTracks } from './overlay.js';

const $ = id => document.getElementById(id);
const video = $('video');
const display = $('display');
const displayCtx = display.getContext('2d');
const overlay = $('overlay');
const overlayCtx = overlay.getContext('2d');
const stage = $('stage');

const params = resolveParams(loadSaved(localStorage), parseHash(location.hash));
let source = null;
let loop = null;
let cvState = { ready: false, cv: null, ms: null };
let pipeline = null;
let lastOut = null;              // last pipeline output, kept for re-rendering while paused
const skipped = { count: 0, reasons: {} };
let score = null;                // synthetic sources: candidates against ground truth
let confScore = null;            // … and confirmed detections
const log = createExportLog();
const APP_VERSION = '0.4.0';

// Test hook (see tests/): recent frames and state, no effect on the UI.
const FRAME_LOG = 5000;
const ph = window.__ph = { params, frames: [], results: [], cvState, ready: false, error: null };

function showBanner(text) {
    const b = $('banner');
    b.textContent = text;
    b.hidden = false;
}

function fatal(text) {
    ph.error = text;
    showBanner(text);
    for (const el of document.querySelectorAll('button, input')) el.disabled = true;
}

// --- parameter controls -------------------------------------------------------------------

function renderParams() {
    for (const def of PARAM_DEFS) {
        const host = $(`params-${def.group}`);
        if (!host) continue;
        const row = document.createElement('div');
        row.className = 'param';
        if (def.type === 'choice') {
            const seg = document.createElement('div');
            seg.className = 'segmented';
            seg.setAttribute('role', 'radiogroup');
            seg.setAttribute('aria-label', def.label);
            for (const [value, text] of def.choices) {
                const label = document.createElement('label');
                const input = document.createElement('input');
                input.type = 'radio';
                input.name = `param-${def.key}`;
                input.value = value;
                input.checked = params[def.key] === value;
                input.addEventListener('change', () => setParam(def.key, value));
                label.append(input, text);
                seg.append(label);
            }
            row.append(seg);
        } else if (def.type === 'bool') {
            const label = document.createElement('label');
            label.className = 'check';
            const input = document.createElement('input');
            input.type = 'checkbox';
            input.id = `param-${def.key}`;
            input.checked = params[def.key];
            input.addEventListener('change', () => setParam(def.key, input.checked));
            label.append(input, def.label);
            row.append(label);
        } else {
            const label = document.createElement('label');
            const name = document.createElement('span');
            name.textContent = def.label;
            const value = document.createElement('span');
            value.className = 'value mono';
            label.append(name, value);
            const input = document.createElement('input');
            input.type = 'range';
            input.min = def.min;
            input.max = def.max;
            input.step = def.step;
            input.value = params[def.key];
            input.id = `param-${def.key}`;
            const show = () => { value.textContent = `${params[def.key]}${def.unit ? ' ' + def.unit : ''}`; };
            input.addEventListener('input', () => { setParam(def.key, Number(input.value)); show(); });
            show();
            row.append(label, input);
        }
        host.append(row);
    }
}

function setParam(key, value) {
    params[key] = value;
    save(localStorage, params);
    if (key === 'mode') { if (loop) loop.setMode(value); }
    else if (['view', 'showCandidates', 'showTruth'].includes(key)) render();
    else if (pipeline) {
        pipeline.setParams(params);
        if (score) score.reset();       // new settings: score from here on
        if (confScore) confScore.reset();
    }
}

// --- frames -------------------------------------------------------------------------------

function busyWait(ms) {
    const end = performance.now() + ms;
    while (performance.now() < end) { /* simulated processing */ }
}

// Ground-truth targets (source px) in processing-resolution px.
function truthTargets(r) {
    const s = r.scale;
    if (s === 1) return r.truth.targets;
    return r.truth.targets.map(t => ({ ...t, cx: (t.cx + 0.5) * s - 0.5, cy: (t.cy + 0.5) * s - 0.5,
        x: (t.x + 0.5) * s - 0.5, y: (t.y + 0.5) * s - 0.5, w: t.w * s, h: t.h * s }));
}

function onFrame(f) {
    const out = pipeline.push({ image: f.video, imageData: f.imageData, width: f.width, height: f.height, time: f.time,
        frame: f.frame, seq: f.seq, gap: f.gap, jump: f.jump, truth: f.truth });
    if (params.simLoad > 0) busyWait(params.simLoad);
    lastOut = out;
    const r = out.result;
    if (r && r.egoNext && !r.egoNext.ok) {
        skipped.count++;
        skipped.reasons[r.egoNext.reason] = (skipped.reasons[r.egoNext.reason] || 0) + 1;
    }
    if (r && r.truth && score && r.detect.ok) {
        r.score = score.add(r.frame, r.candidates, truthTargets(r));
        r.confScore = confScore.add(r.frame, r.confirmed.map(t => t.box), truthTargets(r));
    }
    if (r && r.confirmed.length) log.add(r);
    render();
    if (!f.video) updateTransport();

    ph.frames.push({ seq: f.seq, frame: f.frame, time: f.time, gap: f.gap, jump: f.jump });
    if (ph.frames.length > FRAME_LOG) ph.frames.shift();
    ph.lastFrame = ph.frames[ph.frames.length - 1];
    ph.lastResult = r;
    if (r) {
        const e = r.egoNext;
        ph.results.push({ seq: r.seq, frame: r.frame, time: r.time, ok: e.ok, reason: e.reason, H: e.Hfull || null,
            tracked: e.tracked, inliers: e.inliers, timings: r.timings,
            detectOk: r.detect.ok, detectReason: r.detect.reason, scale: r.scale, candidates: r.candidates.map(c => [c.cx, c.cy, c.area]), score: r.score ? { tp: r.score.tp, fp: r.score.fp, fn: r.score.fn } : null,
            confirmed: r.confirmed.map(t => [t.id, t.box.cx, t.box.cy]) });
        if (ph.results.length > FRAME_LOG) ph.results.shift();
    }
    ph.shown = out.slot.meta;
}

// Draws the current output in the chosen view: the frame on the display canvas, marks on the
// overlay.
function render() {
    if (!lastOut) return;
    const g = pipeline.geometry;
    if (display.width !== g.w || display.height !== g.h) {
        display.width = g.w;
        display.height = g.h;
    }
    const note = pipeline.renderView(params.view, lastOut, displayCtx);
    const tf = fitOverlay(overlay, g.w, g.h);
    clear(overlayCtx);
    const r = lastOut.result;
    if (params.view === 'points' && r) drawPoints(overlayCtx, tf, r.egoNext, r.small);
    if (r && params.showTruth && r.truth) drawTruth(overlayCtx, tf, truthTargets(r));
    if (r && params.showCandidates && params.view !== 'points') drawBoxes(overlayCtx, tf, r.candidates, { alpha: 0.55, width: 1 });
    if (r && params.view !== 'points') drawTracks(overlayCtx, tf, r.confirmed);
    if (note) drawNote(overlayCtx, tf, note);
    ph.note = note;
}

// --- sources ------------------------------------------------------------------------------

// next: a video source (sources.js), or { kind: 'synthetic', label, scene }
async function openSource(next) {
    if (loop) { loop.destroy(); loop = null; }
    if (source && source.stop) source.stop(video);
    source = null;
    $('empty').hidden = true;
    $('srcLabel').textContent = `Loading ${next.label}…`;
    if (next.kind !== 'synthetic') {
        try {
            await next.start(video);
        } catch (e) {
            $('srcLabel').textContent = next.label;
            showBanner(e.message);
            $('empty').hidden = false;
            return;
        }
    }
    source = next;
    $('banner').hidden = true;
    lastOut = null;
    skipped.count = 0;
    skipped.reasons = {};
    ph.frames.length = 0;
    ph.results.length = 0;
    if (next.kind === 'synthetic') {
        video.hidden = true;
        score = createScore({ fps: next.scene.fps });
        confScore = createScore({ fps: next.scene.fps });
        $('srcLabel').textContent = `${next.label} · ${next.scene.width}×${next.scene.height}`;
        loop = createSyntheticLoop({ scene: next.scene, onFrame, mode: params.mode });
    } else {
        video.hidden = false;
        score = null;
        confScore = null;
        $('srcLabel').textContent = `${next.label} · ${video.videoWidth}×${video.videoHeight}`;
        loop = createFrameLoop({ video, onFrame, mode: params.mode });
    }
    ph.loop = loop;
    ph.score = score;
    ph.confScore = confScore;
    ph.log = log;
    log.clear();
    await loop.start({ probe: !next.isLive });
    // frame t is shown once t+s has arrived (s = stride): load them so the first frame has its result
    if (!next.isLive) for (let i = 0; i < Math.max(1, params.stride); i++) await loop.step();
    for (const id of ['play', 'step', 'timeline']) $(id).disabled = false;
    updateTransport();
}

function openFile(file) {
    if (!file || !cvState.ready) return;
    openSource(fileSource(file));
}

function openScene(key) {
    if (!cvState.ready || !SCENES[key]) return;
    $('srcLabel').textContent = `Rendering ${SCENES[key].label}…`;
    // let the label paint before the (synchronous) world texture is built
    setTimeout(() => openSource({ kind: 'synthetic', label: SCENES[key].label, isLive: false, scene: createScene(SCENES[key].options) }), 20);
}

// --- transport ----------------------------------------------------------------------------

function fmtTime(t) {
    if (!Number.isFinite(t)) return '–';
    const m = Math.floor(t / 60);
    return `${m}:${(t - m * 60).toFixed(3).padStart(6, '0')}`;
}

function updateTransport() {
    $('play').textContent = loop && loop.playing ? 'Pause' : 'Play';
    if (!loop) return;
    const shown = lastOut ? lastOut.slot.meta.time : loop.time;
    $('time').textContent = `${fmtTime(shown)} / ${fmtTime(loop.duration)}`;
    if (!scrubbing && Number.isFinite(loop.duration) && loop.duration > 0) {
        $('timeline').value = Math.round(loop.time / loop.duration * 1000);
    }
}

function togglePlay() {
    if (!loop) return;
    if (loop.playing) loop.pause();
    else loop.play().catch(e => showBanner(`Playback failed: ${e.message}`));
    updateTransport();
}

let scrubbing = false;

function bindTransport() {
    $('play').addEventListener('click', togglePlay);
    $('step').addEventListener('click', () => loop && loop.step().then(updateTransport));
    const tl = $('timeline');
    tl.addEventListener('input', () => {
        scrubbing = true;
        if (loop && Number.isFinite(loop.duration)) loop.seek(tl.value / 1000 * loop.duration);
    });
    tl.addEventListener('change', () => { scrubbing = false; });
    for (const ev of ['play', 'pause', 'timeupdate', 'seeked', 'ended']) video.addEventListener(ev, updateTransport);

    document.addEventListener('keydown', e => {
        if (e.target instanceof HTMLInputElement && e.target.type !== 'range') return;
        if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
        else if (e.code === 'ArrowRight' && loop) { e.preventDefault(); loop.step().then(updateTransport); }
    });

    for (const b of document.querySelectorAll('[data-open]')) b.addEventListener('click', () => $('file').click());
    $('file').addEventListener('change', e => { openFile(e.target.files[0]); e.target.value = ''; });
    const pick = $('scene');
    for (const [key, s] of Object.entries(SCENES)) pick.append(new Option(s.label, key));
    $('openScene').addEventListener('click', () => openScene(pick.value));
    $('exportJson').addEventListener('click', exportJson);
    $('clearLog').addEventListener('click', () => { log.clear(); updateStats(); });
    stage.addEventListener('dragover', e => { e.preventDefault(); stage.classList.add('dragover'); });
    stage.addEventListener('dragleave', () => stage.classList.remove('dragover'));
    stage.addEventListener('drop', e => {
        e.preventDefault();
        stage.classList.remove('dragover');
        openFile(e.dataTransfer.files[0]);
    });
}

function exportJson() {
    if (!log.count || !pipeline.geometry) return;
    const g = pipeline.geometry;
    const keys = PARAM_DEFS.filter(d => !['view', 'showCandidates', 'showTruth', 'simLoad'].includes(d.key)).map(d => d.key);
    const meta = {
        app: 'PixelHunter', version: APP_VERSION, source: source ? source.label : null,
        width: g.srcW, height: g.srcH, fps: loop && loop.stats().sourceFps,
        params: Object.fromEntries(keys.map(k => [k, params[k]])),
        created: new Date().toISOString(),
        units: 'source-video pixels; box = [x, y, w, h] of pixel edges; time = media time, s; vx / vy = px per frame against the background',
    };
    const base = (source && source.label ? source.label.replace(/\.[^.]+$/, '') : 'pixelhunter').replace(/[^\w.-]+/g, '_');
    download(`${base}.detections.json`, log.toJSON(meta));
}

// --- stats --------------------------------------------------------------------------------

function updateStats() {
    if (!loop) return;
    const s = loop.stats();
    const fps = v => (v === null ? '–' : v.toFixed(1));
    $('stSource').textContent = s.sourceFps === null ? '–' : `${fps(s.sourceFps)} fps`;
    $('stFps').textContent = `${s.processedFps} fps`;
    $('stDropped').textContent = s.recovered ? `${s.dropped} (${s.recovered} recovered)` : String(s.dropped);
    $('stRate').textContent = s.stepping ? 'stepping' : `${s.rate.toFixed(2)}×`;
    $('stFrame').textContent = ph.shown && ph.shown.frame !== null ? String(ph.shown.frame) : '–';
    $('stCost').textContent = s.costMs === null ? '–' : `${s.costMs.toFixed(1)} ms`;
    const r = lastOut && lastOut.result;
    const e = r && r.egoNext;
    $('stPoints').textContent = e ? String(e.tracked) : '–';
    $('stInliers').textContent = e ? `${e.inliers} (${Math.round(e.ratio * 100)} %)` : '–';
    $('stSkipped').textContent = String(skipped.count);
    $('stReason').textContent = Object.entries(skipped.reasons).map(([k, n]) => `${k}: ${n}`).join(' · ');
    $('stGrab').textContent = r ? `${r.timings.grab.toFixed(1)} ms` : '–';
    $('stEgo').textContent = r ? `${r.timings.ego.toFixed(1)} ms` : '–';
    $('stDetect').textContent = r ? `${r.timings.detect.toFixed(1)} ms` : '–';
    $('stCand').textContent = r ? (r.detect.ok ? `${r.candidates.length}${r.detect.noisy ? '+' : ''}` : '–') : '–';
    $('stTracks').textContent = r ? `${r.confirmed.length} confirmed · ${r.tracks.length - r.tracks.filter(t => t.state === 'confirmed').length} tentative` : '–';
    const sc = score && score.summary(), cs = confScore && confScore.summary();
    $('rowScore').hidden = !sc;
    const hit = v => (v === null ? '–' : `${Math.round(v * 100)} %`);
    if (sc) {
        $('stScore').textContent = sc.frames ? `${hit(sc.hitRate)} hit · ${sc.fpPerFrame.toFixed(2)} FP/frame` : '–';
        $('stScoreConf').textContent = cs.frames ? `${hit(cs.hitRate)} hit · ${cs.fpPer10s.toFixed(1)} FP/10 s` : '–';
    }
    $('logCount').textContent = log.count ? `${log.count} confirmed detections, ${log.tracks} tracks` : 'No confirmed detections yet';
    $('exportJson').disabled = $('clearLog').disabled = !log.count;
    ph.stats = { ...s, skipped: skipped.count, skippedReasons: { ...skipped.reasons }, score: sc, confScore: cs };
}

// --- startup ------------------------------------------------------------------------------

async function start() {
    renderParams();
    bindTransport();
    setInterval(updateStats, 250);
    if (typeof video.requestVideoFrameCallback !== 'function') {
        fatal('This browser does not support requestVideoFrameCallback, which PixelHunter needs to read video frames. Use a current Chrome, Edge, Firefox or Safari.');
        return;
    }
    const status = $('cvStatus');
    try {
        const { cv, ms } = await loadCv();
        const missing = checkCv(cv);
        if (missing.functions.length || missing.constants.length) {
            const names = [...missing.functions, ...missing.constants];
            status.textContent = 'OpenCV.js incomplete';
            status.className = 'pill error';
            fatal(`The OpenCV.js build is missing what PixelHunter needs: ${names.join(', ')}.`);
            ph.missing = names;
            return;
        }
        Object.assign(cvState, { ready: true, cv, ms });
        pipeline = createPipeline(cv, params);
        ph.pipeline = pipeline;
        new ResizeObserver(() => render()).observe(stage);
        status.textContent = `OpenCV.js ${CV_VERSION} ready`;
        status.className = 'pill ok';
        $('stCv').textContent = `${(ms / 1000).toFixed(1)} s load`;
        ph.ready = true;
    } catch (e) {
        status.textContent = 'OpenCV.js failed';
        status.className = 'pill error';
        fatal(`OpenCV.js could not be loaded: ${e.message}`);
    }
}

start();
