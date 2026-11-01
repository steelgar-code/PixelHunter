// Wiring: OpenCV.js startup check, sources, frame loop, parameter controls and stats.
import { loadCv, checkCv, CV_VERSION } from './cvLoader.js';
import { fileSource, urlSource } from './sources.js';
import { createFrameLoop } from './frameLoop.js';
import { createSyntheticLoop } from './synthLoop.js';
import { createScene } from './synth.js';
import { SCENES } from './scenes.js';
import { PARAM_DEFS, PRESETS, matchingPreset, resolveParams, parseHash, loadSaved, save } from './params.js';
import { HELP, SECTION_HELP } from './help.js';
import { loadPresets, savePresets, presetFrom, upsert, remove, find, changesOf, describe, toFile, fromFile } from './userPresets.js';
import { createPipeline } from './pipeline.js';
import { createScore } from './score.js';
import { createExportLog, download } from './exportLog.js';
import { createObjects } from './objects.js';
import { createObjectsView } from './objectsView.js';
import { fitOverlay, clear, drawPoints, drawNote, drawBoxes, drawTruth, drawTracks, drawBuilding, drawHeld, drawOffscreen, drawZones, drawInclude } from './overlay.js';
import { normalizeZone, normalizeZones, parseZones, formatZones, zoneRect, inZones, loadZones, saveZones, MAX_ZONES, ZONES_KEY, INCLUDE_KEY } from './zones.js';

const $ = id => document.getElementById(id);
const video = $('video');
const display = $('display');
const displayCtx = display.getContext('2d');
const overlay = $('overlay');
const overlayCtx = overlay.getContext('2d');
const stage = $('stage');

const hash = parseHash(location.hash);
let userPresets = loadPresets(localStorage);
// #preset=<name> may name one of the user's presets: its settings go under the hash values
const hashUserPreset = hash.preset && !PRESETS[hash.preset] ? find(userPresets, hash.preset) : null;
const params = resolveParams({ ...loadSaved(localStorage), ...(hashUserPreset ? hashUserPreset.values : {}) }, hash);
// Zones of each kind: from the hash (#exclude=x,y,w,h;… / #include=…) if given, else the saved ones.
const ZONE_KINDS = {
    exclude: { param: 'zones', storage: ZONES_KEY, list: 'zoneList', text: 'zoneText' },
    include: { param: 'include', storage: INCLUDE_KEY, list: 'includeList', text: 'includeText' },
};
for (const [kind, k] of Object.entries(ZONE_KINDS)) {
    params[k.param] = kind in hash ? parseZones(hash[kind])
        : hashUserPreset && hashUserPreset[k.param] ? hashUserPreset[k.param] : loadZones(localStorage, k.storage);
}
let source = null;
let loop = null;
let cvState = { ready: false, cv: null, ms: null };
let pipeline = null;
let lastOut = null;              // last pipeline output, kept for re-rendering while paused
const skipped = { count: 0, reasons: {} };
let score = null;                // synthetic sources: candidates against ground truth
let confScore = null;            // … and confirmed detections
const log = createExportLog();
const APP_VERSION = '0.7.0';

// Test hook (see tests/): recent frames and state, no effect on the UI.
const FRAME_LOG = 5000;
const ph = window.__ph = { params, frames: [], results: [], cvState, ready: false, error: null, setZones: (kind, z) => setZones(kind, z), applyPreset: k => applyPreset(k),
    get userPresets() { return userPresets; } };

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

const syncers = new Map();       // key → puts params[key] into its control
// display-only settings: a change redraws, nothing is recomputed
const VIEW_KEYS = ['view', 'showCandidates', 'showBuilding', 'showTruth', 'showZones', 'showHud'];
// settings of the app itself (what is shown, cards): not part of a detection run's settings
const UI_GROUPS = ['view', 'objects'];

// A "?" button that shows / hides `text` in a paragraph appended to `host`.
function helpToggle(host, text, name) {
    const p = document.createElement('p');
    p.className = 'help';
    p.textContent = text;
    p.hidden = true;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'help-btn';
    b.textContent = '?';
    b.title = `What does ${name} do?`;
    b.setAttribute('aria-expanded', 'false');
    b.addEventListener('click', e => {
        e.preventDefault();                 // inside a panel's summary: don't fold the panel
        p.hidden = !p.hidden;
        b.setAttribute('aria-expanded', String(!p.hidden));
    });
    host.append(p);
    return b;
}

// Sliders in a scrolling panel: a touch that starts on one scrolls the panel unless it is
// clearly sideways; then the value follows the finger relative to where it started (no jump to
// the touch point). A mouse drags or clicks as usual. The input itself takes no pointer events
// (keyboard still works once focused).
function guardSlider(input, def) {
    const wrap = document.createElement('div');
    wrap.className = 'slider';
    wrap.append(input);
    const min = Number(def.min), max = Number(def.max), step = Number(def.step);
    const decimals = (String(def.step).split('.')[1] || '').length;
    const snap = v => +(Math.min(max, Math.max(min, min + Math.round((v - min) / step) * step))).toFixed(decimals);
    const set = v => {
        const n = snap(v);
        if (n === Number(input.value)) return;
        input.value = n;
        input.dispatchEvent(new Event('input'));
    };
    const track = () => input.getBoundingClientRect();
    const at = x => { const r = track(); return min + Math.min(1, Math.max(0, (x - r.left - 8) / Math.max(1, r.width - 16))) * (max - min); };
    let g = null;                // { id, x, y, v, mouse, dragging }
    const capture = id => { try { wrap.setPointerCapture(id); } catch { /* pointer already gone */ } };
    wrap.addEventListener('pointerdown', e => {
        if (e.button !== 0) return;
        g = { id: e.pointerId, x: e.clientX, y: e.clientY, v: Number(input.value), mouse: e.pointerType === 'mouse', dragging: false };
        if (g.mouse) {
            g.dragging = true;
            capture(e.pointerId);
            input.focus({ preventScroll: true });
            set(at(e.clientX));
        }
    });
    wrap.addEventListener('pointermove', e => {
        if (!g || e.pointerId !== g.id) return;
        const dx = e.clientX - g.x, dy = e.clientY - g.y;
        if (!g.dragging) {
            if (Math.abs(dy) > 8 && Math.abs(dy) >= Math.abs(dx)) { g = null; return; }      // a scroll
            if (Math.abs(dx) < 10 || Math.abs(dx) < 2 * Math.abs(dy)) return;               // not yet clear
            g.dragging = true;
            g.x = e.clientX;                                                                 // start from here: no jump
            capture(e.pointerId);
            wrap.classList.add('dragging');
            return;
        }
        if (g.mouse) set(at(e.clientX));
        else set(g.v + (e.clientX - g.x) / Math.max(1, track().width - 16) * (max - min));
    });
    const end = () => { g = null; wrap.classList.remove('dragging'); };
    wrap.addEventListener('pointerup', end);
    wrap.addEventListener('pointercancel', end);
    return wrap;
}

function stepButton(text, title, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'step-btn';
    b.textContent = text;
    b.title = title;
    b.addEventListener('click', onClick);
    return b;
}

function renderParams() {
    for (const def of PARAM_DEFS) {
        const host = $(`params-${def.group}`);
        if (!host) continue;
        const row = document.createElement('div');
        row.className = 'param';
        const head = document.createElement('div');
        head.className = 'param-head';
        row.append(head);
        if (def.type === 'choice') {
            const name = document.createElement('span');
            name.className = 'param-name';
            name.textContent = def.label;
            // no caption when the section heading already says it (Processing, View)
            const heading = host.closest('section, details').querySelector('h2, summary');
            if (heading && heading.textContent.trim().toLowerCase() === def.label.toLowerCase()) name.textContent = '';
            head.append(name);
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
            syncers.set(def.key, () => { for (const i of seg.querySelectorAll('input')) i.checked = i.value === params[def.key]; });
            row.append(seg);
        } else if (def.type === 'bool') {
            const label = document.createElement('label');
            label.className = 'check';
            const input = document.createElement('input');
            input.type = 'checkbox';
            input.id = `param-${def.key}`;
            input.checked = params[def.key];
            input.addEventListener('change', () => setParam(def.key, input.checked));
            syncers.set(def.key, () => { input.checked = params[def.key]; });
            label.append(input, def.label);
            head.append(label);
        } else {
            const name = document.createElement('label');
            name.className = 'param-name';
            name.textContent = def.label;
            name.htmlFor = `param-${def.key}`;
            const value = document.createElement('span');
            value.className = 'value mono';
            const input = document.createElement('input');
            input.type = 'range';
            input.min = def.min;
            input.max = def.max;
            input.step = def.step;
            input.value = params[def.key];
            input.id = `param-${def.key}`;
            const show = () => { value.textContent = `${params[def.key]}${def.unit ? ' ' + def.unit : ''}`; };
            input.addEventListener('input', () => { setParam(def.key, Number(input.value)); show(); });
            syncers.set(def.key, () => { input.value = params[def.key]; show(); });
            show();
            const nudge = dir => {
                const decimals = (String(def.step).split('.')[1] || '').length;
                const v = +(Math.min(def.max, Math.max(def.min, Number(input.value) + dir * def.step))).toFixed(decimals);
                if (v === Number(input.value)) return;
                input.value = v;
                input.dispatchEvent(new Event('input'));
            };
            const controls = document.createElement('span');
            controls.className = 'param-value';
            controls.append(stepButton('−', `Decrease ${def.label}`, () => nudge(-1)), value, stepButton('+', `Increase ${def.label}`, () => nudge(1)));
            head.append(name, controls);
            row.append(guardSlider(input, def));
        }
        if (HELP[def.key]) head.append(helpToggle(row, HELP[def.key], def.label));
        if (def.when) conditional.push([row, def.when]);
        host.append(row);
    }
    updateConditional();
    // section explanations
    for (const [key, text] of Object.entries(SECTION_HELP)) {
        const h = document.querySelector(`[data-help=${key}]`);
        if (h) h.append(helpToggle(h.closest('details, .tab-panel').querySelector('.help-host') || h.parentElement, text, h.textContent.trim() || key));
    }
    $('helpAll').addEventListener('click', () => {
        showTab('settings');
        const show = [...document.querySelectorAll('.help-btn')].some(b => b.getAttribute('aria-expanded') === 'false');
        for (const b of document.querySelectorAll('.help-btn')) if ((b.getAttribute('aria-expanded') === 'true') !== show) b.click();
        $('helpAll').textContent = show ? 'Hide explanations' : 'Explain settings';
        // the details sections open too, so every explanation is in view
        if (show) for (const d of document.querySelectorAll('.panel details')) d.open = true;
    });
}

const DEF_GROUP = new Map(PARAM_DEFS.map(d => [d.key, d.group]));

// Settings that only apply when another has a given value (def.when) are shown only then.
const conditional = [];
function updateConditional() {
    for (const [row, when] of conditional) row.hidden = !Object.entries(when).every(([k, v]) => String(params[k]) === String(v));
}

function setParam(key, value) {
    params[key] = value;
    save(localStorage, params);
    updateConditional();
    if (key === 'mode') { if (loop) loop.setMode(value); }
    else if (key === 'speed') { if (loop) loop.setSpeed(Number(value)); }
    else if (VIEW_KEYS.includes(key)) { render(); updateStats(); }
    else if (DEF_GROUP.get(key) === 'objects') { /* read when needed */ }
    else settingsChanged();
}

// Detection settings changed: to the pipeline, score from here on, preset buttons updated.
function settingsChanged() {
    if (pipeline) pipeline.setParams(params);
    if (score) score.reset();
    if (confScore) confScore.reset();
    updatePresets();
    if (typeof updateUpdateButton === 'function' && $('updateUserPreset')) updateUpdateButton();
}

// --- sensitivity presets ------------------------------------------------------------------

function renderPresets() {
    const host = $('presets');
    for (const [key, pr] of Object.entries(PRESETS)) {
        const b = document.createElement('button');
        b.type = 'button';
        b.id = `preset-${key}`;
        b.textContent = pr.label;
        b.title = pr.hint;
        b.addEventListener('click', () => applyPreset(key));
        host.append(b);
    }
    updatePresets();
}

// --- user presets (settings and / or zones, by name) ----------------------------------------

function renderUserPresets(selected) {
    const sel = $('userPreset');
    const keep = selected ?? sel.value;
    sel.replaceChildren(...(userPresets.length ? userPresets.map(p => new Option(p.name, p.name)) : [new Option('none saved yet', '')]));
    if (keep && find(userPresets, keep)) sel.value = find(userPresets, keep).name;
    sel.disabled = !userPresets.length;
    $('applyUserPreset').disabled = $('deleteUserPreset').disabled = !userPresets.length;
    updateUpdateButton();
    $('exportPresets').disabled = !userPresets.length;
    disarmDelete();
    showUserPresetInfo();
    updateSaveButton();
    if ($('quickUser').options.length) renderQuickUser();
}

function showUserPresetInfo(text) {
    const p = find(userPresets, $('userPreset').value);
    $('userPresetInfo').textContent = text || (p ? `Holds ${describe(p)}.` : '');
    $('userPresetInfo').hidden = !$('userPresetInfo').textContent;
}

// Does the current state differ from what preset p holds (only the parts it holds)?
function presetDiffers(p) {
    if (p.values && Object.entries(p.values).some(([k, v]) => String(params[k]) !== String(v))) return true;
    if (p.zones && formatZones(p.zones) !== formatZones(params.zones)) return true;
    if (p.include && formatZones(p.include) !== formatZones(params.include)) return true;
    return false;
}

function updateUpdateButton() {
    const p = find(userPresets, $('userPreset').value);
    $('updateUserPreset').disabled = !p || !presetDiffers(p);
    $('updateUserPreset').title = p ? `Save the current ${[p.values && 'settings', (p.zones || p.include) && 'zones'].filter(Boolean).join(' and ')} into “${p.name}”` : '';
}

function updateSaveButton() {
    const name = $('presetName').value.trim();
    const what = $('saveSettings').checked || $('saveZones').checked;
    $('savePreset').disabled = !name || !what;
    $('savePreset').textContent = name && find(userPresets, name) ? 'Replace' : 'Save';
}

function applyUserPreset(name) {
    const p = find(userPresets, name);
    if (!p) return;
    const ch = changesOf(p);
    Object.assign(params, ch.values);
    save(localStorage, params);
    for (const sync of syncers.values()) sync();
    updateConditional();
    for (const [kind, k] of Object.entries(ZONE_KINDS)) if (ch[k.param]) setZones(kind, ch[k.param]);
    settingsChanged();
    showUserPresetInfo(`Applied “${p.name}”: ${describe(p)}.`);
}

let deleteTimer = null;
function disarmDelete() {
    clearTimeout(deleteTimer);
    $('deleteUserPreset').classList.remove('armed');
    $('deleteUserPreset').textContent = '×';
}

function bindUserPresets() {
    $('applyUserPreset').addEventListener('click', () => applyUserPreset($('userPreset').value));
    $('userPreset').addEventListener('change', () => { disarmDelete(); showUserPresetInfo(); updateUpdateButton(); });
    $('updateUserPreset').addEventListener('click', () => {
        const old = find(userPresets, $('userPreset').value);
        if (!old) return;
        const p = presetFrom(params, old.name, { settings: !!old.values, zones: !!(old.zones || old.include) });
        if (!p) return;
        userPresets = upsert(userPresets, p);
        savePresets(localStorage, userPresets);
        renderUserPresets(p.name);
        showUserPresetInfo(`Updated “${p.name}”: ${describe(p)}.`);
    });
    // delete takes two clicks: the first arms the button for a few seconds
    $('deleteUserPreset').addEventListener('click', () => {
        const b = $('deleteUserPreset');
        if (!b.classList.contains('armed')) {
            b.classList.add('armed');
            b.textContent = 'Delete?';
            deleteTimer = setTimeout(disarmDelete, 3000);
            return;
        }
        userPresets = remove(userPresets, $('userPreset').value);
        savePresets(localStorage, userPresets);
        renderUserPresets();
    });
    for (const id of ['presetName', 'saveSettings', 'saveZones']) $(id).addEventListener('input', updateSaveButton);
    $('savePresetForm').addEventListener('submit', e => {
        e.preventDefault();
        const name = $('presetName').value.trim();
        const p = presetFrom(params, name, { settings: $('saveSettings').checked, zones: $('saveZones').checked });
        if (!p) return;
        userPresets = upsert(userPresets, p);
        savePresets(localStorage, userPresets);
        $('presetName').value = '';
        renderUserPresets(p.name);
        showUserPresetInfo(`Saved “${p.name}”: ${describe(p)}.`);
    });
    $('exportPresets').addEventListener('click', () => download('pixelhunter.presets.json', toFile(userPresets)));
    $('importPresets').addEventListener('click', () => $('presetFile').click());
    $('presetFile').addEventListener('change', async e => {
        const file = e.target.files[0];
        e.target.value = '';
        if (!file) return;
        let added = 0;
        try {
            const r = fromFile(JSON.parse(await file.text()), userPresets);
            userPresets = r.list;
            added = r.added;
        } catch { /* not JSON: nothing added */ }
        savePresets(localStorage, userPresets);
        renderUserPresets();
        showUserPresetInfo(added ? `Imported ${added} preset${added === 1 ? '' : 's'}.` : 'No presets found in that file.');
    });
    renderUserPresets(hashUserPreset ? hashUserPreset.name : undefined);
    if (hashUserPreset) showUserPresetInfo(`Applied “${hashUserPreset.name}” from the address: ${describe(hashUserPreset)}.`);
}

function applyPreset(key) {
    Object.assign(params, PRESETS[key].values);
    save(localStorage, params);
    for (const sync of syncers.values()) sync();
    updateConditional();
    settingsChanged();
}

function updatePresets() {
    const current = matchingPreset(params);
    for (const key of Object.keys(PRESETS)) $(`preset-${key}`).setAttribute('aria-pressed', String(key === current));
    for (const b of document.querySelectorAll('#quickPresets button')) b.setAttribute('aria-pressed', String(b.dataset.preset === current));
    $('presetHint').textContent = current ? `${PRESETS[current].label}: ${PRESETS[current].hint}.` : 'Custom settings. A preset sets detection, confirmation and camera motion as a starting point to tune from.';
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

// Targets whose centre lies in an exclusion zone, or outside the inclusion zones when there are
// any, can't be found: left out of the score.
function scoredTargets(r) {
    return truthTargets(r).filter(t => !inZones(params.zones, t.cx, t.cy, r.width, r.height)
        && (!params.include.length || inZones(params.include, t.cx, t.cy, r.width, r.height)));
}

function onFrame(f) {
    const out = pipeline.push({ image: f.video, imageData: f.imageData, width: f.width, height: f.height, time: f.time,
        frame: f.frame, seq: f.seq, gap: f.gap, jump: f.jump, jumpReason: f.jumpReason, truth: f.truth });
    if (params.simLoad > 0) busyWait(params.simLoad);
    lastOut = out;
    const r = out.result;
    if (r && r.egoNext && !r.egoNext.ok) {
        skipped.count++;
        skipped.reasons[r.egoNext.reason] = (skipped.reasons[r.egoNext.reason] || 0) + 1;
    }
    if (r && r.truth && score && r.detect.ok) {
        r.score = score.add(r.frame, r.candidates, scoredTargets(r));
        r.confScore = confScore.add(r.frame, r.confirmed.map(t => t.box), scoredTargets(r));
    }
    if (r) noteObjects(out);
    if (r && r.confirmed.length) log.add(r);
    // while refilling the history for a jump (goToTime), only the target frame is drawn
    if (!navigating) {
        render();
        if (!f.video) updateTransport();
    }

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
    ph.renders = (ph.renders || 0) + 1;
    const g = pipeline.geometry;
    if (display.width !== g.w || display.height !== g.h) {
        display.width = g.w;
        display.height = g.h;
    }
    const note = pipeline.renderView(params.view, lastOut, displayCtx);
    const tf = fitOverlay(overlay, g.w, g.h);
    clear(overlayCtx);
    if (params.showZones || drawing) drawInclude(overlayCtx, tf, params.include, g.w, g.h, drawKind === 'include' ? draft : null);
    const r = lastOut.result;
    if (params.view === 'points' && r) drawPoints(overlayCtx, tf, r.egoNext, r.small);
    if (r && params.showTruth && r.truth) drawTruth(overlayCtx, tf, truthTargets(r));
    if (r && params.showCandidates && params.view !== 'points') {
        // dropped by the background-shift check: grey, so the check can be judged
        if (r.detect.rejected && r.detect.rejected.length) drawBoxes(overlayCtx, tf, r.detect.rejected, { colour: '#8b939c', alpha: 0.6, width: 1 });
        drawBoxes(overlayCtx, tf, r.candidates, { alpha: 0.55, width: 1 });
    }
    if (r && params.view !== 'points') {
        const held = r.held || [];
        drawHeld(overlayCtx, tf, asObject(held.filter(t => !isPinnedTrack(t) && !isHiddenTrack(t))));
        drawHeld(overlayCtx, tf, asObject(held.filter(isPinnedTrack)), { colour: PIN_COLOUR });
        // tracks building up: seen at least twice, matched this frame, not confirmed yet
        if (params.showBuilding) drawBuilding(overlayCtx, tf, r.tracks.filter(t => t.state === 'tentative' && t.matched && t.hits >= 2 && t.box && !isHiddenTrack(t)));
        const shown = r.confirmed.filter(t => !isHiddenTrack(t));
        drawTracks(overlayCtx, tf, asObject(shown.filter(t => !isPinnedTrack(t))));
        drawTracks(overlayCtx, tf, asObject(shown.filter(isPinnedTrack)), { colour: PIN_COLOUR });
        // the object in the inspector: a second, wider box
        const open = view.open !== null && shown.find(t => objs.objectOfTrack(t.id) === view.open);
        if (open) drawBoxes(overlayCtx, tf, [open.box], { colour: '#3ea6ff', minScreen: 26, width: 1.5 });
        // pinned and out of view: an arrow at the edge towards it
        drawOffscreen(overlayCtx, tf, asObject(r.tracks.filter(isPinnedTrack)), g.w, g.h, PIN_COLOUR);
    }
    if (params.showZones || drawing) drawZones(overlayCtx, tf, params.zones, g.w, g.h, drawKind === 'exclude' ? draft : null);
    if (note) drawNote(overlayCtx, tf, note);
    ph.note = note;
    view.frameDrawn();
}

// --- detection area: inclusion and exclusion zones ---------------------------------------

let drawing = false;             // draw mode: drags on the stage add zones
let drawKind = 'exclude';        // … of this kind
let draft = null;                // the zone being dragged out
let dragFrom = null;

function setZones(kind, zones) {
    const k = ZONE_KINDS[kind];
    params[k.param] = normalizeZones(zones);
    saveZones(localStorage, params[k.param], k.storage);
    settingsChanged();
    renderZoneLists();
    render();
}

// Source-video pixel rectangle of a zone, as [x, y, w, h] (pixel edges).
function zoneSourceRect(z) {
    const g = pipeline && pipeline.geometry;
    const w = g ? g.srcW : video.videoWidth, h = g ? g.srcH : video.videoHeight;
    if (!w || !h) return null;
    const r = zoneRect(z, w, h);
    return [r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0];
}

function renderZoneLists() {
    for (const [kind, k] of Object.entries(ZONE_KINDS)) {
        const zones = params[k.param];
        $(k.list).replaceChildren(...zones.map((z, i) => {
            const li = document.createElement('li');
            const row = document.createElement('span');
            const px = zoneSourceRect(z);
            const text = document.createElement('span');
            text.textContent = px ? `${px[0]},${px[1]} ${px[2]}×${px[3]} px` : `${z.x},${z.y} ${z.w}×${z.h}`;
            const del = document.createElement('button');
            del.type = 'button';
            del.textContent = '×';
            del.title = `Remove ${kind} zone ${i + 1}`;
            del.addEventListener('click', () => setZones(kind, zones.filter((_, j) => j !== i)));
            row.append(text, del);
            li.append(row);
            return li;
        }));
        if (document.activeElement !== $(k.text)) $(k.text).value = formatZones(zones);
    }
    $('clearZones').disabled = !params.zones.length && !params.include.length;
}

function setDrawing(on) {
    drawing = on;
    draft = dragFrom = null;
    $('drawZone').setAttribute('aria-pressed', String(on));
    $('drawZone').textContent = on ? 'Done drawing' : 'Draw zones';
    stage.classList.toggle('drawing', on);
    render();
}

// Client coordinates → fractions of the frame (the display canvas is fitted with "contain").
function toFrame(e) {
    const g = pipeline && pipeline.geometry;
    if (!g) return null;
    const rect = display.getBoundingClientRect();
    const s = Math.min(rect.width / g.w, rect.height / g.h);
    const ox = (rect.width - g.w * s) / 2, oy = (rect.height - g.h * s) / 2;
    const fx = (e.clientX - rect.left - ox) / (g.w * s), fy = (e.clientY - rect.top - oy) / (g.h * s);
    return [Math.min(1, Math.max(0, fx)), Math.min(1, Math.max(0, fy))];
}

// an event on something floating over the video (inspector, cards), not on the video itself
const onPanel = e => !!(e.target && e.target.closest && e.target.closest('.inspector, .card'));

function bindZones() {
    $('drawZone').addEventListener('click', () => setDrawing(!drawing));
    $('clearZones').addEventListener('click', () => { setZones('include', []); setZones('exclude', []); });
    for (const input of document.querySelectorAll('input[name=zoneKind]')) {
        input.addEventListener('change', () => { drawKind = input.value; if (!drawing) setDrawing(true); });
    }
    for (const [kind, k] of Object.entries(ZONE_KINDS)) $(k.text).addEventListener('change', e => setZones(kind, parseZones(e.target.value)));
    stage.addEventListener('pointerdown', e => {
        if (!drawing || e.button !== 0 || onPanel(e)) return;
        const p = toFrame(e);
        if (!p) return;
        e.preventDefault();
        stage.setPointerCapture(e.pointerId);
        dragFrom = p;
        draft = { x: p[0], y: p[1], w: 0, h: 0 };
    });
    stage.addEventListener('pointermove', e => {
        if (!dragFrom) return;
        const p = toFrame(e);
        draft = { x: Math.min(dragFrom[0], p[0]), y: Math.min(dragFrom[1], p[1]), w: Math.abs(p[0] - dragFrom[0]), h: Math.abs(p[1] - dragFrom[1]) };
        render();
    });
    const end = () => {
        if (!dragFrom) return;
        const g = pipeline.geometry;
        // snapped to whole source pixels, so the list and the export are exact
        const snap = (v, n) => Math.round(v * n) / n;
        const z = normalizeZone(draft && { x: snap(draft.x, g.srcW), y: snap(draft.y, g.srcH), w: snap(draft.x + draft.w, g.srcW) - snap(draft.x, g.srcW), h: snap(draft.y + draft.h, g.srcH) - snap(draft.y, g.srcH) });
        dragFrom = draft = null;
        const zones = params[ZONE_KINDS[drawKind].param];
        if (z && zones.length < MAX_ZONES) setZones(drawKind, [...zones, z]);
        else render();
    };
    stage.addEventListener('pointerup', end);
    // a click on a confirmed object on the video opens it in the inspector; a double click keeps
    // tracking it (or stops)
    stage.addEventListener('click', e => {
        if (drawing || onPanel(e)) return;
        const t = trackAt(e);
        if (t) view.inspect(objs.objectOfTrack(t.id));
    });
    stage.addEventListener('dblclick', e => {
        if (drawing || onPanel(e)) return;
        const t = trackAt(e);
        if (!t) return;
        const oid = objs.objectOfTrack(t.id);
        if (!objs.isPinned(oid)) objs.label(oid, 'object');
        togglePin(oid);
    });
    stage.addEventListener('pointermove', e => {
        if (drawing || e.pointerType !== 'mouse') return;
        stage.classList.toggle('over-object', !onPanel(e) && !!trackAt(e));
    });
    stage.addEventListener('pointercancel', () => { dragFrom = draft = null; render(); });
    renderZoneLists();
}

// --- navigation: one frame back, bookmarks ----------------------------------------------------

let navigating = false;

const waitFor = (cond, ms) => new Promise(resolve => {
    const end = performance.now() + ms;
    const tick = () => (cond() || performance.now() > end ? resolve(cond()) : setTimeout(tick, 15));
    tick();
});

// Frames processed before the target of a jump, beyond what detection itself needs, so tracks
// are confirmed again by the time it is on screen.
const WARM_UP = 5;

// Shows the frame at media time T (s) with its detection result. A jump empties the frame
// history (frame t needs t − s and t + s), so this seeks stride + WARM_UP frames earlier and steps
// forward, without drawing, until the frame at T is shown; then draws it once. Tracking
// restarts with the jump. By time, not frame number: with a variable frame rate, frame numbers
// worked out from time don't count frames exactly.
async function goToTime(T, why = 'seek') {
    if (!loop || navigating || !Number.isFinite(T)) return;
    navigating = true;
    $('stage').classList.add('busy');
    try {
        loop.pause();
        const s = Math.max(1, Math.round(params.stride));
        const fd = 1 / (loop.stats().sourceFps || 25);
        const before = ph.lastFrame ? ph.lastFrame.seq : -1;
        loop.seek(Math.max(0, T - (s + WARM_UP) * fd), why);
        await waitFor(() => ph.lastFrame && ph.lastFrame.seq > before, 3000);
        for (let i = 0; i < 2 * s + WARM_UP + 12 && !(ph.shown && ph.shown.time >= T - 1e-4); i++) {
            if (!(await loop.step())) break;
        }
    } finally {
        navigating = false;
        $('stage').classList.remove('busy');
        render();
        updateTransport();
    }
}

// The media time of the frame before the one shown: the latest frame time decoded so far that
// is earlier (exact also with a variable frame rate), else one frame duration back.
function previousFrameTime() {
    const t = ph.shown && ph.shown.time;
    if (!Number.isFinite(t)) return null;
    let best = -Infinity;
    for (const f of ph.frames) if (f.time < t - 1e-6 && f.time > best) best = f.time;
    const fd = 1 / ((loop && loop.stats().sourceFps) || 25);
    return best > t - 3 * fd ? best : t - fd;
}

// One frame forward. Right after a jump the history may still be short (the display waits for
// t + s): then this goes to the next frame properly instead.
function stepForward() {
    if (!loop || navigating) return;
    const r = lastOut && lastOut.result;
    if (!r && ph.shown && Number.isFinite(ph.shown.time)) {
        // the next frame after the one shown: step from the history's end until it is shown
        const t = ph.shown.time;
        const next = Math.min(...ph.frames.map(f => f.time).filter(x => x > t + 1e-6), Infinity);
        // keep the reason the history restarted (a settings change), not "seek"
        const why = pipeline.resetCause && !['start', 'seek'].includes(pipeline.resetCause) ? pipeline.resetCause : 'seek';
        if (Number.isFinite(next)) { goToTime(next, why); return; }
    }
    loop.step().then(updateTransport);
}

function stepBack() {
    if (navigating) return;
    const T = previousFrameTime();
    if (T !== null && T >= 0) goToTime(T);
}

const BOOKMARKS_KEY = 'pixelhunter.bookmarks.v1';

function loadBookmarks() {
    try { return JSON.parse(localStorage.getItem(BOOKMARKS_KEY) || '{}') || {}; } catch { return {}; }
}

function bookmarksOf(label) { return (loadBookmarks()[label] || []).filter(b => Number.isFinite(b.frame)); }

function saveBookmarks(label, list) {
    try {
        const all = loadBookmarks();
        if (list.length) all[label] = list; else delete all[label];
        localStorage.setItem(BOOKMARKS_KEY, JSON.stringify(all));
    } catch { /* not remembered */ }
}

function addBookmark() {
    if (!source || !ph.shown || ph.shown.frame === null) return;
    const list = bookmarksOf(source.label);
    if (!list.some(b => b.frame === ph.shown.frame)) list.push({ frame: ph.shown.frame, time: ph.shown.time });
    list.sort((a, b) => a.frame - b.frame);
    saveBookmarks(source.label, list);
    renderBookmarks();
}

function renderBookmarks() {
    const host = $('bookmarks');
    const list = source ? bookmarksOf(source.label) : [];
    host.replaceChildren(...list.map(b => {
        const chip = document.createElement('span');
        chip.className = 'chip mono';
        const go = document.createElement('button');
        go.type = 'button';
        go.className = 'go';
        go.textContent = `${fmtTime(b.time)} #${b.frame}`;
        go.title = 'Go to this frame';
        go.addEventListener('click', () => goToTime(b.time));
        const del = document.createElement('button');
        del.type = 'button';
        del.textContent = '×';
        del.title = 'Remove this bookmark';
        del.addEventListener('click', () => { saveBookmarks(source.label, bookmarksOf(source.label).filter(x => x.frame !== b.frame)); renderBookmarks(); });
        chip.append(go, del);
        return chip;
    }));
    host.hidden = !list.length;
    // and as ticks on the timeline
    const dur = loop && loop.duration;
    $('tlMarks').replaceChildren(...(Number.isFinite(dur) && dur > 0 ? list : []).map(b => {
        const m = document.createElement('button');
        m.type = 'button';
        m.style.left = `${Math.min(100, Math.max(0, b.time / dur * 100))}%`;
        m.title = `Bookmark ${fmtTime(b.time)} #${b.frame}`;
        m.setAttribute('aria-label', m.title);
        m.addEventListener('click', () => goToTime(b.time));
        return m;
    }));
}

// --- objects: the list, inspector, cards, timeline lanes and history (objectsView.js) -----------

const PIN_COLOUR = '#ff9f43';
const objs = createObjects({ kept: 40 });

function clearObjects() {
    objs.clear();
    if (view) view.clear();
    if (pipeline) pipeline.setPinned([]);
}

function noteObjects(out) {
    const r = out.result;
    const changes = objs.update(r, out.slot.grey, { frameDuration: 1 / ((loop && loop.stats().sourceFps) || 25) });
    // re-linking may move a pin to another track: the tracker watches the current ones
    if (objs.pinnedCount) pipeline.setPinned(objs.pinnedTrackIds());
    // tracks shown with their object's id
    for (const t of r.tracks) t.objectId = objs.objectOfTrack(t.id);
    view.noteFrame(r, out.slot, changes);
}

// object id of a track (for drawing and the export); the track id until it is an object
const oidOf = t => (t.objectId ?? objs.objectOfTrack(t.id)) ?? t.id;
const asObject = list => list.map(t => ({ ...t, id: oidOf(t) }));
const isPinnedTrack = t => { const o = objs.objectOfTrack(t.id); return o !== null && objs.isPinned(o); };
// tracks of objects labelled "not an object" are not drawn
const isHiddenTrack = t => { const o = objs.objectOfTrack(t.id); return o !== null && objs.isHidden(o); };

// Pin or unpin an object (on: true / false, or toggle): pinned ones are drawn in orange, listed
// first, kept watching by the tracker (also stopped or out of view), and re-linked when tracking
// loses them.
function togglePin(oid, on) {
    objs.pin(oid, on);
    if (pipeline) pipeline.setPinned(objs.pinnedTrackIds());
    view.markDirty();
    view.render();
    render();
}

// The object (confirmed or pinned track) under a click on the video, within 14 screen px.
function trackAt(e) {
    const r = lastOut && lastOut.result, g = pipeline && pipeline.geometry, p = toFrame(e);
    if (!r || !g || !p) return null;
    const rect = display.getBoundingClientRect();
    const s = Math.min(rect.width / g.w, rect.height / g.h);
    const x = p[0] * g.w - 0.5, y = p[1] * g.h - 0.5;
    let best = null, bd = 14 / s;
    for (const t of r.tracks) {
        if (objs.objectOfTrack(t.id) === null || isHiddenTrack(t)) continue;
        if (!(t.state === 'confirmed' && t.matched) && !isPinnedTrack(t)) continue;
        const [tx, ty] = t.matched ? [t.box.cx, t.box.cy] : t.lastSeen;
        const d = Math.hypot(tx - x, ty - y);
        if (d < bd) { bd = d; best = t; }
    }
    return best;
}

const fileBase = () => (source && source.label ? source.label.replace(/\.[^.]+$/, '') : 'pixelhunter').replace(/[^\w.-]+/g, '_');
const exportedParams = () => Object.fromEntries(PARAM_DEFS.filter(d => !UI_GROUPS.includes(d.group) && d.key !== 'simLoad').map(d => [d.key, params[d.key]]));

const view = createObjectsView({
    objs, params, $, fmtTime, display, stage, wrap: document.querySelector('.stage-wrap'),
    current: () => ({ r: lastOut && lastOut.result, slot: lastOut && lastOut.slot, geometry: pipeline && pipeline.geometry, loop }),
    goToTime: t => goToTime(t),
    togglePin,
    onChange: () => render(),
    pause: () => { if (loop && loop.playing) { loop.pause(); updateTransport(); } },
    download,
    fileBase,
    exportMeta: () => ({ app: 'PixelHunter', version: APP_VERSION, source: source ? source.label : null, params: exportedParams() }),
});
ph.objectsView = view;

// --- side panel tabs, the source menu, quick presets ------------------------------------------

const TAB_KEY = 'pixelhunter.tab.v1';

function showTab(name) {
    for (const tab of document.querySelectorAll('.tabs [role=tab]')) {
        const on = tab.id === `tab-${name}`;
        tab.setAttribute('aria-selected', String(on));
        $(tab.getAttribute('aria-controls')).hidden = !on;
    }
    try { localStorage.setItem(TAB_KEY, name); } catch { /* not remembered */ }
    if (name === 'objects') { view.markDirty(); view.render(); }
}

function bindTabs() {
    for (const tab of document.querySelectorAll('.tabs [role=tab]')) tab.addEventListener('click', () => showTab(tab.id.replace('tab-', '')));
    let name = 'objects';
    try { name = localStorage.getItem(TAB_KEY) || 'objects'; } catch { /* default */ }
    showTab($(`tab-${name}`) ? name : 'objects');
}

function setMenu(open) {
    $('sourceMenu').hidden = !open;
    $('openMenu').setAttribute('aria-expanded', String(open));
}

function bindSourceMenu() {
    $('openMenu').addEventListener('click', e => { e.stopPropagation(); setMenu($('sourceMenu').hidden); });
    document.addEventListener('pointerdown', e => {
        if (!$('sourceMenu').hidden && !e.target.closest('.source-pick')) setMenu(false);
    });
}

// Highest / Mid / Low and the user's presets, in the top bar (the full preset controls are in
// Settings).
function renderQuickPresets() {
    const host = $('quickPresets');
    host.replaceChildren(...Object.entries(PRESETS).map(([key, pr]) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.dataset.preset = key;
        b.textContent = pr.label;
        b.title = pr.hint;
        b.addEventListener('click', () => applyPreset(key));
        return b;
    }));
    renderQuickUser();
    $('quickUser').addEventListener('change', e => {
        if (e.target.value) applyUserPreset(e.target.value);
        e.target.value = '';
    });
}

function renderQuickUser() {
    const sel = $('quickUser');
    sel.replaceChildren(new Option(userPresets.length ? 'My presets…' : 'My presets: none', ''), ...userPresets.map(p => new Option(p.name, p.name)));
    sel.disabled = !userPresets.length;
}

// --- panels: remember which are folded ---------------------------------------------------------

const PANELS_KEY = 'pixelhunter.panels.v1';

function bindPanels() {
    let state = {};
    try { state = JSON.parse(localStorage.getItem(PANELS_KEY) || '{}') || {}; } catch { /* defaults */ }
    for (const d of document.querySelectorAll('.panel details[id]')) {
        if (d.id in state) d.open = !!state[d.id];
        d.addEventListener('toggle', () => {
            state[d.id] = d.open;
            try { localStorage.setItem(PANELS_KEY, JSON.stringify(state)); } catch { /* not remembered */ }
        });
    }
}

// --- sources ------------------------------------------------------------------------------

// next: a video source (sources.js), or { kind: 'synthetic', label, scene }
async function openSource(next) {
    setMenu(false);
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
        loop = createSyntheticLoop({ scene: next.scene, onFrame, mode: params.mode, speed: Number(params.speed) });
    } else {
        video.hidden = false;
        score = null;
        confScore = null;
        $('srcLabel').textContent = `${next.label} · ${video.videoWidth}×${video.videoHeight}`;
        loop = createFrameLoop({ video, onFrame, mode: params.mode });
        loop.setSpeed(Number(params.speed));
    }
    ph.loop = loop;
    clearObjects();
    ph.score = score;
    ph.confScore = confScore;
    ph.log = log;
    log.clear();
    await loop.start({ probe: !next.isLive });
    // frame t is shown once t+s has arrived (s = stride): load them so the first frame has its result
    if (!next.isLive) for (let i = 0; i < Math.max(1, params.stride); i++) await loop.step();
    for (const id of ['play', 'step', 'timeline', 'back', 'bookmark']) $(id).disabled = false;
    renderBookmarks();
    renderZoneLists();
    updateTransport();
}

const URL_KEY = 'pixelhunter.url.v1';

function openUrl(href) {
    if (!href || !cvState.ready) return;
    try { localStorage.setItem(URL_KEY, href); } catch { /* not remembered */ }
    openSource(urlSource(href));
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
    const fr = lastOut && lastOut.slot.meta.frame;
    $('time').textContent = `${fmtTime(shown)}${fr !== null && fr !== undefined ? ` #${fr}` : ''} / ${fmtTime(loop.duration)}`;
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

// "1:23.4", "83.4" (seconds) or "#250" (a frame) → media time in s, or null.
function parseGoTo(text, fps) {
    const t = String(text).trim();
    let m;
    if ((m = /^#\s*(\d+)$/.exec(t))) return fps > 0 ? Number(m[1]) / fps : null;
    if ((m = /^(\d+):(\d{1,2}(?:\.\d*)?)$/.exec(t))) return Number(m[1]) * 60 + Number(m[2]);
    if ((m = /^\d+(?:\.\d*)?$/.exec(t))) return Number(t);
    return null;
}

// Click on the time (or G): a field to type a time or a frame number to go to.
function bindGoTo() {
    const form = $('goToForm'), input = $('goTo'), time = $('time');
    const open = () => {
        if (!loop || !Number.isFinite(loop.duration)) return;
        form.hidden = false;
        time.hidden = true;
        input.value = '';
        input.focus();
    };
    const close = () => { form.hidden = true; time.hidden = false; };
    time.addEventListener('click', open);
    time.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    input.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
    input.addEventListener('blur', () => setTimeout(close, 150));
    form.addEventListener('submit', e => {
        e.preventDefault();
        const fps = loop && loop.stats().sourceFps;
        const t = parseGoTo(input.value, fps);
        close();
        if (t === null || !loop || !Number.isFinite(loop.duration)) return;
        // a frame number: its time less a quarter frame, so rounding can't land on the next one
        const to = /^#/.test(input.value.trim()) && fps ? t - 0.25 / fps : t;
        goToTime(Math.min(Math.max(0, to), loop.duration - 1e-3), 'go to');
    });
    return open;
}

function bindTransport() {
    const openGoTo = bindGoTo();
    $('play').addEventListener('click', togglePlay);
    $('step').addEventListener('click', stepForward);
    $('back').addEventListener('click', stepBack);
    $('bookmark').addEventListener('click', addBookmark);
    const tl = $('timeline');
    tl.addEventListener('input', () => {
        scrubbing = true;
        if (loop && Number.isFinite(loop.duration)) loop.seek(tl.value / 1000 * loop.duration);
    });
    // hover: the time (and frame) under the pointer
    const wrap = tl.parentElement;
    wrap.addEventListener('pointermove', e => {
        if (!loop || !Number.isFinite(loop.duration) || tl.disabled) return;
        const r = tl.getBoundingClientRect();
        const f = Math.min(1, Math.max(0, (e.clientX - r.left - 8) / Math.max(1, r.width - 16)));
        const t = f * loop.duration, fps = loop.stats().sourceFps;
        const tip = $('tlHover');
        const lane = e.target === $('tlLanes') ? view.laneAt(e) : null;
        tip.textContent = lane ? `#${lane.o.id}${lane.t !== null ? ` · ${fmtTime(lane.t)}` : ''}` : `${fmtTime(t)}${fps ? ` #${Math.round(t * fps)}` : ''}`;
        tip.style.left = `${e.clientX - wrap.getBoundingClientRect().left}px`;
        tip.hidden = false;
    });
    wrap.addEventListener('pointerleave', () => { $('tlHover').hidden = true; });
    tl.addEventListener('change', () => {
        scrubbing = false;
        // paused: refill the history so the frame shows with its detection result
        if (loop && !loop.playing && Number.isFinite(loop.duration)) goToTime(tl.value / 1000 * loop.duration);
    });
    for (const ev of ['play', 'pause', 'timeupdate', 'seeked', 'ended']) video.addEventListener(ev, updateTransport);

    document.addEventListener('keydown', e => {
        if (e.target instanceof HTMLInputElement && e.target.type !== 'range') return;
        if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
        else if (e.code === 'ArrowRight' && loop) { e.preventDefault(); stepForward(); }
        else if (e.code === 'ArrowLeft' && loop) { e.preventDefault(); stepBack(); }
        else if (e.code === 'KeyB' && loop && !e.ctrlKey && !e.metaKey) addBookmark();
        else if (e.code === 'KeyG' && loop && !e.ctrlKey && !e.metaKey) { e.preventDefault(); openGoTo(); }
        else if (e.code === 'Escape') {
            if (!$('sourceMenu').hidden) setMenu(false);
            else if (drawing) setDrawing(false);
            else if (view.open !== null) view.inspect(null);
        }
    });

    for (const b of document.querySelectorAll('[data-open]')) b.addEventListener('click', () => $('file').click());
    $('file').addEventListener('change', e => { openFile(e.target.files[0]); e.target.value = ''; });
    try { $('srcUrl').value = hash.src || localStorage.getItem(URL_KEY) || ''; } catch { /* storage blocked */ }
    $('urlForm').addEventListener('submit', e => { e.preventDefault(); openUrl($('srcUrl').value.trim()); });
    const pick = $('scene');
    for (const [key, s] of Object.entries(SCENES)) pick.append(new Option(s.label, key));
    $('openScene').addEventListener('click', () => openScene(pick.value));
    $('exportJson').addEventListener('click', exportJson);
    $('clearLog').addEventListener('click', () => { log.clear(); clearObjects(); updateStats(); });
    $('clearObjects').addEventListener('click', () => { log.clear(); clearObjects(); updateStats(); });
    stage.addEventListener('dragover', e => { e.preventDefault(); stage.classList.add('dragover'); });
    stage.addEventListener('dragleave', () => stage.classList.remove('dragover'));
    stage.addEventListener('drop', e => {
        e.preventDefault();
        stage.classList.remove('dragover');
        // a file, or a link dragged from another page
        const link = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
        if (e.dataTransfer.files.length) openFile(e.dataTransfer.files[0]);
        else if (/^https?:\/\//.test(link.trim())) { $('srcUrl').value = link.trim().split('\n')[0]; openUrl($('srcUrl').value); }
    });
}

function exportJson() {
    if (!log.count || !pipeline.geometry) return;
    const g = pipeline.geometry;
    const keys = PARAM_DEFS.filter(d => !UI_GROUPS.includes(d.group) && d.key !== 'simLoad').map(d => d.key);
    const meta = {
        app: 'PixelHunter', version: APP_VERSION, source: source ? source.label : null,
        width: g.srcW, height: g.srcH, fps: loop && loop.stats().sourceFps,
        params: Object.fromEntries(keys.map(k => [k, params[k]])),
        // fractions of the frame, and the same in source-video pixels [x, y, w, h]
        excludeZones: params.zones.map(z => ({ ...z, px: zoneSourceRect(z) })),
        includeZones: params.include.map(z => ({ ...z, px: zoneSourceRect(z) })),
        created: new Date().toISOString(),
        units: 'source-video pixels; box = [x, y, w, h] of pixel edges; time = media time, s; vx / vy = px per frame against the background',
    };
    download(`${fileBase()}.detections.json`, log.toJSON(meta, view.summary()));
}

// --- stats --------------------------------------------------------------------------------

function updateStats() {
    view.render();
    $('clearObjects').disabled = !objs.list().length && !log.count;
    if (!loop) { $('hud').hidden = true; return; }
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
    $('stFit').textContent = r && r.fit ? `${r.fit.err90.toFixed(2)} px · ${Math.round(r.fit.coverage * 100)} %` : '–';
    $('stSkipped').textContent = String(skipped.count);
    $('stReason').textContent = Object.entries(skipped.reasons).map(([k, n]) => `${k}: ${n}`).join(' · ');
    $('stGrab').textContent = r ? `${r.timings.grab.toFixed(1)} ms` : '–';
    $('stEgo').textContent = r ? `${r.timings.ego.toFixed(1)} ms` : '–';
    const area = r && r.detect.ok && r.detect.processedArea < 1 ? ` (${Math.round(r.detect.processedArea * 100)} % area)` : '';
    $('stDetect').textContent = r ? `${r.timings.detect.toFixed(1)} ms${area}` : '–';
    const why = r && r.detect.ok ? [r.detect.shiftRejected && `${r.detect.shiftRejected} shift`, r.detect.sizeRejected && `${r.detect.sizeRejected} size`,
        r.detect.slivers && `${r.detect.slivers} sliver`].filter(Boolean) : [];
    const dropped = why.length ? ` (dropped: ${why.join(', ')})` : '';
    $('stCand').textContent = r ? (r.detect.ok ? `${r.candidates.length}${r.detect.noisy ? '+' : ''}${dropped}` : '–') : '–';
    const nState = st => (r ? r.tracks.filter(t => t.state === st).length : 0);
    $('stTracks').textContent = r ? `${r.confirmed.length} confirmed · ${nState('tentative')} tentative${nState('held') ? ` · ${nState('held')} held` : ''}` : '–';
    const sc = score && score.summary(), cs = confScore && confScore.summary();
    $('rowScore').hidden = !sc;
    const hit = v => (v === null ? '–' : `${Math.round(v * 100)} %`);
    if (sc) {
        $('stScore').textContent = sc.frames ? `${hit(sc.hitRate)} hit · ${sc.fpPerFrame.toFixed(2)} FP/frame` : '–';
        $('stScoreConf').textContent = cs.frames ? `${hit(cs.hitRate)} hit · ${cs.fpPer10s.toFixed(1)} FP/10 s` : '–';
    }
    const hud = $('hud');
    hud.hidden = !params.showHud || !r;
    if (!hud.hidden) {
        const live = r.confirmed.filter(t => !isHiddenTrack(t)).length;
        hud.textContent = `${s.processedFps} fps · ${s.costMs === null ? '–' : s.costMs.toFixed(0)} ms · ${r.detect.ok ? r.candidates.length : '–'} candidates · ${live} object${live === 1 ? '' : 's'}${r.detect.ok ? '' : ' · no detection'}`;
    }
    $('logCount').textContent = log.count ? `${log.count} confirmed detections, ${log.tracks} tracks` : 'No confirmed detections yet';
    $('exportJson').disabled = $('clearLog').disabled = !log.count;
    ph.stats = { ...s, skipped: skipped.count, skippedReasons: { ...skipped.reasons }, score: sc, confScore: cs };
}

// --- startup ------------------------------------------------------------------------------

async function start() {
    renderParams();
    bindPanels();
    bindTabs();
    bindSourceMenu();
    view.bind();
    renderPresets();
    renderQuickPresets();
    bindUserPresets();
    bindTransport();
    bindZones();
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
        // #src=<URL-encoded link> opens that video at once (repeatable test runs)
        if (hash.src) openUrl(hash.src);
    } catch (e) {
        status.textContent = 'OpenCV.js failed';
        status.className = 'pill error';
        fatal(`OpenCV.js could not be loaded: ${e.message}`);
    }
}

start();
