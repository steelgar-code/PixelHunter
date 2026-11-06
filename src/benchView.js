// The Benchmark tab: runs the open clip through several settings sets at once and scores each
// against the clip's labels (benchScore.js).
//
// A run decodes the clip once, in every-frame mode, on a hidden <video> of its own (synthetic
// scenes: rendered frame by frame), and hands each frame to one pipeline per set; the user's
// player is paused and stays where it is. Each set's confirmed tracks are kept (source px), so
// the table is scored again whenever the labels change (labelling an unmatched track, or
// extending a label that a set found earlier). A run is saved with the clip's data
// (dataStore.js: results/ in the data folder, else browser storage) and the latest one is shown
// again when the clip is opened.

import { PRESETS, PARAM_DEFS, coerce } from './params.js';
import { PRESET_KEYS } from './userPresets.js';
import { createPipeline } from './pipeline.js';
import { createWorkerPipeline } from './workerPipeline.js';
import { createFrameLoop } from './frameLoop.js';
import { createSyntheticLoop } from './synthLoop.js';
import { scoreRun, compactPts } from './benchScore.js';

const STATE_KEY = 'pixelhunter.bench.v1';
const MS_GUESS = 80;               // ms per frame per set at 640×360, for the estimate before a run
const DEF = new Map(PARAM_DEFS.map(d => [d.key, d]));

export function createBenchView(d) {
    // d: { $, params, labels (labelsView), source(), loop(), geometry(), cv(), pause(), goToTime(t),
    //      fmtTime(t), userPresets(), download(name, data) }
    const { $ } = d;
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(STATE_KEY) || '{}') || {}; } catch { /* defaults */ }
    const chosen = new Set(Array.isArray(saved.chosen) ? saved.chosen : ['preset:mid', 'current']);
    let changes = Array.isArray(saved.changes) ? saved.changes.filter(c => DEF.has(c.key)) : [];   // [{ key, value }]
    const remember = () => { try { localStorage.setItem(STATE_KEY, JSON.stringify({ chosen: [...chosen], changes })); } catch { /* not kept */ } };

    let result = null;         // the run shown: { created, fps, clip, sets: [{ key, name, params, times, tracks, ms }] }
    let selected = 0;          // the set whose details are shown
    let running = null;        // { cancel() } while a run goes
    let progress = null;

    // --- settings sets -------------------------------------------------------------------------

    // a setting's value as shown: the choice's label, On / Off, or the number with its unit
    function valueText(key, value) {
        const def = DEF.get(key);
        if (def.type === 'choice') { const c = def.choices.find(x => String(x[0]) === String(value)); return c ? c[1] : String(value); }
        if (def.type === 'bool') return String(value) === 'true' ? 'on' : 'off';
        return `${value}${def.unit && !def.unit.startsWith('(') ? ` ${def.unit}` : ''}`;
    }
    const changeName = c => `Current · ${DEF.get(c.key).label}: ${valueText(c.key, c.value)}`;
    function allSets() {
        const out = Object.entries(PRESETS).map(([k, p]) => ({ key: `preset:${k}`, name: p.label }));
        for (const p of d.userPresets()) if (p.values) out.push({ key: `user:${p.name}`, name: `${p.name} (mine)` });
        out.push({ key: 'current', name: 'Current settings' });
        for (const c of changes) out.push({ key: `change:${c.key}=${c.value}`, name: changeName(c), change: c });
        return out;
    }

    // The full settings of a set: the current ones with the set's on top; a set's own zones if
    // it has them, else the current zones. Always every frame.
    function paramsOf(key) {
        const base = { ...d.params };
        let p = base;
        if (key.startsWith('preset:')) p = { ...base, ...PRESETS[key.slice(7)].values };
        else if (key.startsWith('user:')) {
            const u = d.userPresets().find(x => x.name === key.slice(5));
            if (u) p = { ...base, ...(u.values || {}), zones: u.zones || base.zones, include: u.include || base.include };
        } else if (key.startsWith('change:')) {
            const [k, v] = key.slice(7).split('=');
            const val = coerce(k, v);
            if (val !== undefined) p = { ...base, [k]: val };
        }
        return { ...p, mode: 'everyFrame' };
    }
    const keptParams = p => ({ ...Object.fromEntries(PRESET_KEYS.map(k => [k, p[k]])), engine: p.engine, workers: p.workers, zones: p.zones || [], include: p.include || [] });

    // --- running -----------------------------------------------------------------------------

    function canRun() {
        const s = d.source();
        if (!s) return 'Open a video first.';
        if (s.isLive) return 'Live sources can\'t be benchmarked (a run needs a clip with an end).';
        if (!d.cv()) return 'OpenCV.js isn\'t ready yet.';
        return null;
    }

    async function run() {
        const why = canRun();
        if (why || running) { renderControls(why); return; }
        const defs = allSets().filter(s => chosen.has(s.key));
        if (!defs.length) { renderControls('Choose at least one settings set.'); return; }
        const source = d.source(), cv = d.cv();
        d.pause();
        const sets = defs.map(def => {
            const params = paramsOf(def.key);
            return { key: def.key, name: def.name, params: keptParams(params), pipe: params.engine === 'workers' ? createWorkerPipeline(cv, params) : createPipeline(cv, params), times: [], tracks: new Map(), ms: [] };
        });
        let cancelled = false, loop = null, video = null, copy = null, borrowed = false;
        const t0 = performance.now();
        let duration = null;
        running = { cancel() { cancelled = true; if (loop) loop.pause(); } };
        progress = { at: 0, duration: null, started: t0 };
        renderControls();

        // every set's pipeline takes the frame at once; Workers ones answer later (all in parallel)
        function onFrame(f) {
            const outs = sets.map(s => s.pipe.push({ image: f.video, imageData: f.imageData, width: f.width, height: f.height, time: f.time, frame: f.frame,
                seq: f.seq, gap: f.gap, jump: f.jump, jumpReason: f.jumpReason }));
            if (outs.some(o => o && typeof o.then === 'function')) {
                // results noted in order; the next frame comes as soon as every engine can take it
                // (Workers: while this one is still being detected)
                pendingNotes = Promise.all(outs).then(all => noteOuts(f, all));
                const accepting = sets.map((s, i) => (outs[i] && typeof outs[i].then === 'function' ? s.pipe.accepting || outs[i] : null)).filter(Boolean);
                return Promise.all(accepting);
            }
            noteOuts(f, outs);
            return null;
        }
        let pendingNotes = Promise.resolve();
        function noteOuts(f, outs) {
            sets.forEach((s, i) => {
                const r = outs[i] && outs[i].result;
                if (!r) return;
                s.times.push(r.time);
                s.ms.push(r.timings.total);
                const sc = r.scale || 1;
                for (const t of r.confirmed) {
                    const b = t.box;
                    let tr = s.tracks.get(t.id);
                    if (!tr) s.tracks.set(t.id, tr = { id: t.id, pts: [] });
                    tr.pts.push([r.time, (b.cx + 0.5) / sc - 0.5, (b.cy + 0.5) / sc - 0.5, b.w / sc, b.h / sc]);
                }
            });
            progress.at = f.time;
            const now = performance.now();
            if (!progress.shown || now - progress.shown > 250) { progress.shown = now; renderProgress(); }
        }

        try {
            if (source.kind === 'synthetic') {
                loop = createSyntheticLoop({ scene: source.scene, onFrame, mode: 'everyFrame', speed: 4 });
                duration = source.scene.frames / source.scene.fps;
            } else {
                video = document.createElement('video');
                video.muted = true;
                video.playsInline = true;
                video.preload = 'auto';
                video.className = 'bench-video';
                document.body.append(video);
                // the same clip opened again on it (file, URL, HLS recording: as the player did)
                copy = d.copySource(source);
                await copy.start(video);
                // frames from a hidden video? (some browsers don't render them): else the player
                if (bench.testHiddenFails || !(await framesCome(video))) {
                    copy.stop(video);
                    copy = null;
                    video.remove();
                    video = d.borrowPlayer();
                    borrowed = true;
                    renderControls('This browser gives no frames from a hidden video: the run uses the player (the clip is opened again after it).');
                    if (video.currentTime > 0) await new Promise(r => { video.addEventListener('seeked', r, { once: true }); video.currentTime = 0; });
                }
                duration = video.duration;
                loop = createFrameLoop({ video, onFrame, mode: 'everyFrame' });
                loop.setSpeed(2);
            }
            progress.duration = duration;
            await loop.start({ probe: true });
            if (!cancelled) {
                await loop.play();
                await new Promise(resolve => {
                    const check = () => (cancelled || !loop.playing ? resolve() : setTimeout(check, 150));
                    check();
                });
            }
            await pendingNotes;           // the last frames' results
            const fps = (loop.stats().sourceFps) || (source.scene ? source.scene.fps : 25);
            if (!cancelled) {
                result = {
                    app: 'PixelHunter', kind: 'benchmark', version: 1, created: new Date().toISOString(),
                    clip: d.labels.set ? d.labels.set.clip : { name: source.label }, fps: +fps.toFixed(3),
                    seconds: +((performance.now() - t0) / 1000).toFixed(1),
                    sets: sets.map(s => ({ key: s.key, name: s.name, params: s.params, times: s.times.map(t => Math.round(t * 1000) / 1000),
                        tracks: [...s.tracks.values()].map(tr => ({ id: tr.id, pts: compactPts(tr.pts) })), ms: s.ms.map(v => Math.round(v * 10) / 10) })),
                };
                selected = 0;
                await saveResult();
            }
        } catch (e) {
            progress.error = e.message || String(e);
        } finally {
            if (loop) loop.destroy();
            for (const s of sets) s.pipe.dispose();
            if (video && !borrowed) { if (copy) copy.stop(video); video.remove(); }
            const err = progress.error, wasCancelled = cancelled, kept = result;
            running = null;
            progress = null;
            if (borrowed) {
                // the clip opened again (its latest saved run comes back; this one if it wasn't saved)
                await d.returnPlayer();
                if (kept && !result) result = kept;
            }
            renderControls(err ? `Run failed: ${err}` : wasCancelled ? 'Run cancelled.' : borrowed ? 'Done (the run used the player; the clip was opened again).' : null);
            render();
        }
    }

    // Does this (hidden) video hand over frames? A short seek must bring a frame callback.
    function framesCome(video, ms = 2500) {
        return new Promise(resolve => {
            let handle = null;
            const timer = setTimeout(() => { if (handle !== null) video.cancelVideoFrameCallback(handle); resolve(false); }, ms);
            handle = video.requestVideoFrameCallback(() => {
                clearTimeout(timer);
                video.addEventListener('seeked', () => resolve(true), { once: true });
                video.currentTime = 0;
            });
            video.currentTime = Math.min(0.1, (video.duration || 1) / 2);
        });
    }

    async function saveResult() {
        if (!result || !d.labels.set) return;
        const summary = scoreAll().map(x => ({ name: x.set.name, ...x.score.summary }));
        try { result.where = await d.labels.store.saveResult(d.labels.set.clip, { ...result, labels: labelInfo(), summary }); } catch (e) { result.where = `not saved: ${e.message}`; }
    }

    const labelInfo = () => { const s = d.labels.set; return s ? { real: s.objects.filter(o => o.label === 'real').length, not: s.objects.filter(o => o.label === 'not').length, complete: s.complete, changed: s.changed } : null; };

    // --- scoring and the table ---------------------------------------------------------------

    function scoreAll() {
        if (!result) return [];
        return result.sets.map(s => ({ set: s, score: scoreRun(d.labels.set, { times: s.times, tracks: s.tracks, ms: s.ms }, { fps: result.fps }) }));
    }

    const pct = v => (v === null || v === undefined ? '–' : `${Math.round(v * 100)}%`);
    const sec = v => (v === null || v === undefined ? '–' : `${v < 0 ? '−' : ''}${Math.abs(v).toFixed(2)} s`);
    function el(tag, props = {}, ...kids) {
        const e = document.createElement(tag);
        for (const [k, v] of Object.entries(props)) {
            if (k === 'on') for (const [ev, fn] of Object.entries(v)) e.addEventListener(ev, fn);
            else if (k === 'class') e.className = v;
            else if (k === 'text') e.textContent = v;
            else e.setAttribute(k, v);
        }
        e.append(...kids.filter(x => x !== null && x !== undefined));
        return e;
    }

    function render() {
        renderSets();
        renderClip();
        const host = $('benchResults');
        if (!result) { host.replaceChildren(); $('benchExport').disabled = true; return; }
        $('benchExport').disabled = false;
        const scored = scoreAll();
        const lab = d.labels.set;
        const head = el('p', { class: 'muted', text: `Run of ${new Date(result.created).toLocaleString()} · ${scored[0] ? scored[0].score.summary.frames : 0} frames${result.seconds ? ` in ${Math.round(result.seconds)} s` : ''}${result.where ? ` · ${result.where === 'folder' ? 'saved in the data folder' : result.where === 'browser' ? 'kept in this browser' : result.where}` : ''}` });
        const table = el('table', { class: 'bench-table mono' },
            el('thead', {}, el('tr', {}, ...[['Settings', ''], ['Found', 'Real objects found / labelled'], ['Frames', 'Share of the frames inside real labels with a confirmed sighting on the path'],
                ['Lat.', 'Median latency: label start → first confirmed sighting (negative: earlier than labelled)'], ['False', 'False tracks per minute (count)'],
                ['Unk.', 'Tracks on no label while the clip is not marked complete'], ['ms', 'Processing time per frame of this set']].map(([t, title]) => el('th', { text: t, ...(title ? { title } : {}) })))),
            el('tbody', {}, ...scored.map((x, i) => {
                const s = x.score.summary;
                return el('tr', { class: i === selected ? 'selected' : '', title: 'Show the details of this set', on: { click: () => { selected = i; render(); } } },
                    el('td', { text: x.set.name }),
                    el('td', { text: s.labelled ? `${s.found} / ${s.labelled}` : '–' }),
                    el('td', { text: pct(s.frameRecall) }),
                    el('td', { text: sec(s.latency) }),
                    el('td', { text: s.complete || s.falseTracks ? `${s.falsePerMin.toFixed(1)} (${s.falseTracks})` : '–' }),
                    el('td', { text: String(s.unknown) }),
                    el('td', { text: s.ms === null ? '–' : s.ms.toFixed(0) }));
            })));
        const notes = [];
        if (!lab || !lab.objects.length) notes.push('No labels for this clip yet: everything found is "unknown". Label objects (Objects tab), or label the tracks below.');
        else if (!lab.complete) notes.push('False alarms are only counted on "not an object" labels until "All real objects in this clip are labelled" is ticked (Objects tab); the rest is "unknown".');
        const x = scored[Math.min(selected, scored.length - 1)];
        host.replaceChildren(head, el('div', { class: 'bench-scroll' }, table), ...notes.map(t => el('p', { class: 'muted', text: t })), x ? details(x) : '');
    }

    function details({ set, score }) {
        const lab = d.labels.set;
        const byId = new Map((lab ? lab.objects : []).map(o => [o.id, o]));
        const reals = score.perLabel.filter(l => l.label === 'real');
        const realList = el('ol', { class: 'bench-list' }, ...reals.map(l => {
            const o = byId.get(l.id);
            const start = o.keys[0][0];
            const found = l.tracks.length > 0;
            return el('li', {},
                el('span', { class: found ? 'ok' : 'miss', text: found ? '✓' : '–' }),
                el('span', { class: 'mono', text: `${o.source === 'marked' ? 'marked' : 'real'} ${d.fmtTime(start)}–${d.fmtTime(o.keys[o.keys.length - 1][0])}` }),
                el('span', { class: 'mono muted', text: found ? `latency ${sec(l.latency)}` : 'not found' }),
                el('button', { type: 'button', text: 'Go to', on: { click: () => d.goToTime(start) } }),
                l.earliest ? el('button', { type: 'button', text: `Extend to ${d.fmtTime(l.earliest[0][0])}`, title: 'This set found it earlier than labelled: add those sightings to the label', on: { click: () => { d.labels.extendLabel(l.id, l.earliest); render(); } } }) : null);
        }));
        const others = score.perTrack.filter(t => t.verdict !== 'real');
        const tracks = new Map(set.tracks.map(t => [t.id, t]));
        const otherList = el('ol', { class: 'bench-list' }, ...others.map(t => {
            const why = t.verdict === 'false' ? (t.labelId ? 'false: on a "not" label' : 'false: on no label') : 'unknown';
            return el('li', {},
                el('span', { class: t.verdict === 'false' ? 'bad' : 'unk', text: t.verdict === 'false' ? '✗' : '?' }),
                el('span', { class: 'mono', text: `#${t.id} ${d.fmtTime(t.first)}–${d.fmtTime(t.last)} · ${t.frames} f` }),
                el('span', { class: 'muted', text: why }),
                el('button', { type: 'button', text: 'Go to', on: { click: () => d.goToTime(t.first) } }),
                t.labelId ? null : el('button', { type: 'button', text: '✓ Real', title: 'Label this track a real object (its path becomes the label)', on: { click: () => { d.labels.addFromTrack('real', tracks.get(t.id).pts); render(); } } }),
                t.labelId ? null : el('button', { type: 'button', text: '✗ Not', title: 'Label this track not an object', on: { click: () => { d.labels.addFromTrack('not', tracks.get(t.id).pts); render(); } } }));
        }));
        return el('div', { class: 'bench-details' },
            el('h3', { text: `${set.name}: real objects (${reals.filter(l => l.tracks.length).length} of ${reals.length} found)` }),
            reals.length ? realList : el('p', { class: 'muted', text: 'No real objects labelled.' }),
            el('h3', { text: `${set.name}: other tracks (${others.length})` }),
            others.length ? otherList : el('p', { class: 'muted', text: 'None.' }));
    }

    function renderSets() {
        const sets = allSets();
        for (const k of [...chosen]) if (!sets.some(s => s.key === k)) chosen.delete(k);
        $('benchSets').replaceChildren(...sets.map(s => el('label', { class: 'check' },
            Object.assign(el('input', { type: 'checkbox', 'data-key': s.key, on: { change: e => { if (e.target.checked) chosen.add(s.key); else chosen.delete(s.key); remember(); renderControls(); } } }), { checked: chosen.has(s.key) }),
            s.name,
            s.change ? el('button', { type: 'button', class: 'icon', text: '×', title: 'Remove this set', on: { click: e => { e.preventDefault(); changes = changes.filter(c => c !== s.change); chosen.delete(s.key); remember(); render(); } } }) : null)));
    }

    function renderClip() {
        const s = d.source(), lab = d.labels.set;
        const c = lab ? { real: lab.objects.filter(o => o.label === 'real').length, not: lab.objects.filter(o => o.label === 'not').length } : null;
        $('benchClip').textContent = !s ? 'Open a video, label its objects (Objects tab), then compare settings here.'
            : s.isLive ? 'Live sources can\'t be benchmarked.'
            : `${s.label}: ${c ? `${c.real} real, ${c.not} not an object${lab.complete ? ', all real objects labelled' : ''}` : 'labels loading…'}`;
    }

    function renderControls(message) {
        const why = canRun();
        $('benchRun').disabled = !!running || !!why || !chosen.size;
        $('benchCancel').hidden = !running;
        $('benchProgress').hidden = !running;
        const n = chosen.size, s = d.source(), loop = d.loop();
        const dur = loop && Number.isFinite(loop.duration) ? loop.duration : null;
        const fps = (loop && loop.stats().sourceFps) || 25;
        const g = d.geometry && d.geometry();
        const area = g ? g.w * g.h / (640 * 360) : 1;
        const est = dur && n ? dur * fps * n * MS_GUESS * area / 1000 : null;
        $('benchProgressText').textContent = message || (running ? 'Starting…' : why || (est ? `${n} set${n === 1 ? '' : 's'}: about ${est < 90 ? `${Math.max(1, Math.round(est))} s` : `${Math.round(est / 60)} min`} for this clip (inclusion zones or a smaller processing width make it quicker).` : ''));
        if (s) renderClip();
    }

    function renderProgress() {
        if (!progress) return;
        const f = progress.duration ? Math.min(1, progress.at / progress.duration) : 0;
        $('benchProgress').value = f;
        const el2 = (performance.now() - progress.started) / 1000;
        const left = f > 0.02 ? el2 * (1 - f) / f : null;
        $('benchProgressText').textContent = `${d.fmtTime(progress.at)}${progress.duration ? ` of ${d.fmtTime(progress.duration)}` : ''} · ${Math.round(f * 100)}%${left !== null ? ` · about ${left < 90 ? `${Math.round(left)} s` : `${Math.round(left / 60)} min`} left` : ''}`;
    }

    // --- binding -----------------------------------------------------------------------------

    function bind() {
        const keys = ['engine', ...PRESET_KEYS].filter(k => DEF.get(k) && ['number', 'choice', 'bool'].includes(DEF.get(k).type));
        $('benchChangeKey').replaceChildren(...keys.map(k => new Option(DEF.get(k).label, k)));
        // the value control follows the setting: a list of its choices, On / Off, or a number in
        // its range (starting at the current value)
        const valueControl = () => {
            const def = DEF.get($('benchChangeKey').value);
            let input;
            if (def.type === 'choice' || def.type === 'bool') {
                input = document.createElement('select');
                const opts = def.type === 'bool' ? [['true', 'On'], ['false', 'Off']] : def.choices.map(([v, label]) => [String(v), label]);
                input.replaceChildren(...opts.map(([v, label]) => new Option(label, v)));
                const cur = String(d.params[def.key]);
                // the other value first: a change is what is wanted
                input.value = opts.find(o => o[0] !== cur) ? opts.find(o => o[0] !== cur)[0] : cur;
            } else {
                input = document.createElement('input');
                input.type = 'number';
                input.min = def.min;
                input.max = def.max;
                input.step = def.step || 'any';
                input.value = String(d.params[def.key]);
                input.className = 'mono';
                input.title = `${def.min}–${def.max}${def.unit ? ` ${def.unit}` : ''}`;
            }
            input.id = 'benchChangeValue';
            input.setAttribute('aria-label', `${def.label}: value`);
            $('benchChangeValueHost').replaceChildren(input);
        };
        $('benchChangeKey').addEventListener('change', valueControl);
        valueControl();
        $('benchChangeForm').addEventListener('submit', e => {
            e.preventDefault();
            const key = $('benchChangeKey').value, v = coerce(key, $('benchChangeValue').value.trim());
            if (v === undefined) { const def = DEF.get(key); renderControls(`${def.label}: a number from ${def.min} to ${def.max}.`); return; }
            const c = { key, value: String(v) };
            if (!changes.some(x => x.key === c.key && x.value === c.value)) changes.push(c);
            chosen.add(`change:${c.key}=${c.value}`);
            remember();
            render();
            renderControls();
        });
        $('benchRun').addEventListener('click', run);
        $('benchCancel').addEventListener('click', () => { if (running) running.cancel(); });
        $('benchExport').addEventListener('click', () => {
            if (!result) return;
            const summary = scoreAll().map(x => ({ name: x.set.name, ...x.score.summary }));
            const base = (result.clip && result.clip.name ? result.clip.name.replace(/\.[^.]+$/, '') : 'clip').replace(/[^\w.-]+/g, '_');
            d.download(`${base}.benchmark.json`, { ...result, labels: labelInfo(), summary });
        });
    }

    const bench = {
        testHiddenFails: false,          // tests: behave as if hidden videos gave no frames
        bind() { bind(); render(); renderControls(); },
        run,
        render,
        renderControls,
        // a new clip: its latest saved run, if any
        async openClip() {
            result = null;
            selected = 0;
            render();
            renderControls();
            const lab = d.labels.set;
            if (!lab) return;
            const r = await d.labels.store.latestResult(lab.clip).catch(() => null);
            if (r && d.labels.set === lab && r.sets) { result = r; render(); }
        },
        cancel() { if (running) running.cancel(); },
        get running() { return !!running; },
        get result() { return result; },
        scores: () => scoreAll().map(x => ({ name: x.set.name, key: x.set.key, ...x.score.summary, perLabel: x.score.perLabel, perTrack: x.score.perTrack })),
    };
    return bench;
}
