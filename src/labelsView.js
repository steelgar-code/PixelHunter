// Labels in the app: the clip's saved labels (labels.js) kept in step with the objects the user
// labels (Real / Not an object / Keep tracking), "Mark missed" on the video, labels drawn on
// the video, objects re-found on a labelled clip shown with their label, crops of labelled
// objects, bookmarks, and saving (dataStore.js: a data folder, else browser storage) with the
// Labels box (Objects tab) and the Data folder section (Settings).

import { newLabelSet, newLabelId, upsertObject, removeObject, removeKeyAt, keysFromHistory, mergeKeys, simplify, labelAt,
    interpolate, extendRadius, counts, changedSince, normalizeLabelSet, mergeLabelSets, normalizeBookmarks, labelsFileName,
    fileClipId, urlClipId, sceneClipId } from './labels.js';
import { createDataStore, folderSupported } from './dataStore.js';
import { cropToPng, CROP } from './crops.js';

const SAVE_MS = 1000;              // after a change by the user
const PATH_SAVE_MS = 4000;         // after a labelled object's path grew (while playing)
const CROPS_MAX = 5;               // per object: the clearest sighting + up to 4 along the path
const CROP_EVERY = 2;              // s between crops along the path
const SNAP_PX = 6;                 // source px: a click snaps to a candidate this close
const MARK_SIZE = 4;               // source px: a marked point's size without a candidate
const LINK_SLACK = 0.25;           // s: a label's path counts this far beyond its ends when re-finding objects
const PATH_WINDOW = 2;             // s of path drawn before and after the frame shown
const COLOURS = { real: '#4cc38a', not: '#8b939c', marked: '#5ce1ff' };
const OLD_BOOKMARKS_KEY = 'pixelhunter.bookmarks.v1';

export function createLabelsView(d) {
    // d: { $, params, objs, current() → { r, slot, geometry, loop }, source(), pipeline(), busy(),
    //      render(), download(name, data), toFrame(e), onBookmarks(), onLabelsChanged(),
    //      onEdit(): after any change to the labels }
    const { $, objs } = d;
    const store = createDataStore();
    let set = null;                    // the clip's labels, or null (live source, none open)
    let clipLabel = null;              // the source's label (for the old bookmarks)
    let loadToken = 0;
    let state = { from: null, exported: null, saving: false, error: null, saved: null, where: null };
    let dirty = false, saveTimer = null, savingP = Promise.resolve();
    const pendingKeys = new Map();     // label id → new points (source px) not merged yet
    const crops = new Map();           // oid → { best: { q, rgba, t }, along: [{ rgba, t }], v }
    const labelCrops = new Map();      // label id → [{ name, rgba, saved }] (marked objects, and tracked ones once labelled)
    let marking = false;
    let markId = null;                 // the label being marked (mark mode)
    const marks = [];                  // [{ id, t }] points marked, for Undo

    // --- clip --------------------------------------------------------------------------------

    // Opens the labels of a source (after it started): { kind, label, file?, url?, scene? },
    // with the video's size and duration. Live sources have none.
    async function openClip(source, { width, height, duration }) {
        const token = ++loadToken;
        // the previous clip's changes not saved yet (saving waits ~1 s after a change)
        if (set && dirty) await flush();
        if (token !== loadToken) return;
        set = null;
        clipLabel = source ? source.label : null;
        pendingKeys.clear(); crops.clear(); labelCrops.clear();
        setMarking(false);
        state = { from: null, exported: null, saving: false, error: null, saved: null, where: null };
        dirty = false;
        clearTimeout(saveTimer);
        if (!source || source.isLive) { renderAll(); return; }
        let id;
        try {
            if (source.kind === 'file' && source.file) id = await fileClipId(source.file);
            else if (source.kind === 'synthetic') id = await sceneClipId(source.scene.options || source.label);
            else id = await urlClipId(source.url || source.label, duration, width, height);
        } catch (e) { state.error = `no clip id: ${e.message}`; renderAll(); return; }
        const clip = { id, name: source.label, bytes: source.file ? source.file.size : null, duration: Number.isFinite(duration) ? +duration.toFixed(3) : null, width, height, fps: null };
        let loaded = { set: null };
        try { loaded = await store.loadClip(clip); } catch (e) { state.error = e.message; }
        if (token !== loadToken) return;
        // renamed (or details missing before): saved under the new name
        if (loaded.set && (loaded.set.clip.name !== clip.name || loaded.set.clip.width !== width)) dirty = true;
        set = loaded.set || newLabelSet(clip);
        set.clip = { ...set.clip, name: clip.name, bytes: clip.bytes ?? set.clip.bytes, duration: clip.duration ?? set.clip.duration, width, height };
        state.from = loaded.inFolder ? 'folder' : loaded.inBrowser ? 'browser' : null;
        state.exported = loaded.exported || null;
        // bookmarks kept by the file name before labels existed: moved into the clip's labels
        const old = oldBookmarks(clipLabel);
        if (old.length) { set.bookmarks = normalizeBookmarks([...set.bookmarks, ...old]); dirty = true; }
        // a browser copy the folder doesn't have yet: written now
        if (loaded.pending && store.usable) dirty = true;
        if (dirty) schedule(0);
        renderAll();
        d.onBookmarks();
    }

    function oldBookmarks(label) {
        try { const all = JSON.parse(localStorage.getItem(OLD_BOOKMARKS_KEY) || '{}') || {}; return label && Array.isArray(all[label]) ? all[label] : []; } catch { return []; }
    }
    function dropOldBookmarks(label) {
        try {
            const all = JSON.parse(localStorage.getItem(OLD_BOOKMARKS_KEY) || '{}') || {};
            if (!label || !(label in all)) return;
            delete all[label];
            if (Object.keys(all).length) localStorage.setItem(OLD_BOOKMARKS_KEY, JSON.stringify(all)); else localStorage.removeItem(OLD_BOOKMARKS_KEY);
        } catch { /* left */ }
    }

    // --- saving ------------------------------------------------------------------------------

    function changed(ms = SAVE_MS) { dirty = true; schedule(ms); renderAll(); if (d.onEdit) d.onEdit(); }

    function schedule(ms) {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => { saveTimer = null; flush(); }, ms);
    }

    // Writes pending changes now. Resolves when saved (or failed).
    function flush() {
        clearTimeout(saveTimer);
        saveTimer = null;
        savingP = savingP.then(async () => {
            if (!set || !dirty) return;
            mergePending();
            const fps = d.current().loop && d.current().loop.stats().sourceFps;
            if (fps) set.clip.fps = +fps.toFixed(3);
            dirty = false;
            state.saving = true;
            renderStatus();
            try {
                const blobs = await newCropBlobs();
                const snapshot = JSON.parse(JSON.stringify(set));
                state.where = await store.saveClip(snapshot, blobs);
                for (const list of labelCrops.values()) for (const c of list) if (blobs[c.name]) c.saved = true;
                state.saved = new Date();
                state.error = null;
                if (state.where === 'browser' && set.objects.length) store.persist();
                dropOldBookmarks(clipLabel);
            } catch (e) {
                state.error = e.message || String(e);
                dirty = true;
            }
            state.saving = false;
            renderAll();
        });
        return savingP;
    }

    function mergePending() {
        if (!set) return;
        for (const [id, pts] of pendingKeys) {
            const o = set.objects.find(x => x.id === id);
            if (o && pts.length) { o.keys = simplify(mergeKeys(o.keys, pts)); o.changed = set.changed = new Date().toISOString(); }
        }
        pendingKeys.clear();
    }

    async function newCropBlobs() {
        const out = {};
        for (const [id, list] of labelCrops) {
            if (!set.objects.some(o => o.id === id)) continue;
            for (const c of list) if (!c.saved) out[c.name] = await cropToPng(c.rgba);
        }
        return out;
    }

    // --- objects ↔ labels ----------------------------------------------------------------------

    const toSrc = (v, s) => (v + 0.5) / s - 0.5;
    const toProc = (v, s) => (v + 0.5) * s - 0.5;

    // The user labelled object oid (objs.label already set): the clip's labels follow.
    function onLabel(oid) {
        const o = objs.get(oid);
        if (!o || !set) return;
        if (!o.label) {
            if (o.labelId) { removeObject(set, o.labelId); labelCrops.delete(o.labelId); pendingKeys.delete(o.labelId); objs.setLabelId(oid, null); }
            changed();
            return;
        }
        const id = o.labelId || newLabelId();
        upsertObject(set, { id, label: o.label, source: 'tracked', size: [o.w, o.h], contrast: o.contrast, keys: keysFromHistory(o.history) });
        objs.setLabelId(oid, id);
        attachCrops(oid, id);
        changed();
    }

    // In-memory crops of an object become the label's (saved with it): <id>-0 its clearest
    // sighting, <id>-1… along its path; crops of marked points (<id>-m<ms>) stay.
    function attachCrops(oid, id) {
        const c = crops.get(oid);
        if (!c) return;
        const list = [c.best, ...c.along].filter(x => x && x.rgba).slice(0, CROPS_MAX);
        const prev = labelCrops.get(id) || [];
        const tracked = list.map((x, i) => {
            const name = `${id}-${i}`;
            const old = prev.find(p => p.name === name);
            return old && old.rgba === x.rgba ? old : { name, rgba: x.rgba, saved: false };
        });
        labelCrops.set(id, [...prev.filter(p => p.name.startsWith(`${id}-m`)), ...tracked]);
        const o = set.objects.find(x => x.id === id);
        if (o) o.crops = [...new Set([...o.crops.filter(n => n.startsWith(`${id}-m`)), ...tracked.map(x => x.name), ...o.crops])].slice(0, 16);
    }

    // After each processed frame (objs.update done): crops, re-found objects, labelled paths.
    function noteFrame(r) {
        if (!r || !set) return;
        const s = r.scale || 1;
        const pipe = d.pipeline();
        let grew = false, linked = false;
        const linkedIds = new Set(objs.list().filter(o => o.labelId && o.last && o.last.frame === r.frame).map(o => o.labelId));
        for (const o of objs.list()) {
            if (!o.last || o.last.frame !== r.frame || o.trackId === null) continue;     // live this frame
            const t = r.tracks.find(x => x.id === o.trackId);
            if (!t || !t.box) continue;
            const x = toSrc(t.box.cx, s), y = toSrc(t.box.cy, s);
            // a crop: its clearest sighting so far, and one every CROP_EVERY s
            if (pipe) {
                const c = crops.get(o.id) || { best: null, along: [] };
                crops.set(o.id, c);
                if (o.best && o.best.frame === r.frame && (!c.best || o.best.q > c.best.q)) c.best = { q: o.best.q, rgba: pipe.crop(t.box.cx, t.box.cy, undefined, t), t: r.time };
                const lastT = c.along.length ? c.along[c.along.length - 1].t : -Infinity;
                if (c.along.length < CROPS_MAX - 1 && r.time - lastT >= CROP_EVERY) c.along.push({ rgba: pipe.crop(t.box.cx, t.box.cy, undefined, t), t: r.time });
                if (o.labelId) attachCrops(o.id, o.labelId);
            }
            // an object not labelled yet on the path of a saved label: it is that label
            if (!o.labelId && !o.label) {
                const l = labelAt(set, r.time, x, y, { slack: LINK_SLACK, except: linkedIds });
                if (l) {
                    objs.label(o.id, l.label, 'from the saved labels');
                    objs.setLabelId(o.id, l.id);
                    linkedIds.add(l.id);
                    linked = true;
                }
            }
            // a labelled object's path grows as it is tracked
            if (o.labelId && set.objects.some(l => l.id === o.labelId)) {
                const pts = pendingKeys.get(o.labelId) || [];
                pts.push([r.time, x, y, t.box.w / s, t.box.h / s]);
                pendingKeys.set(o.labelId, pts);
                grew = true;
            }
        }
        // saved a few seconds after it started growing (not put off while it keeps growing)
        if (grew) { dirty = true; if (!saveTimer) schedule(PATH_SAVE_MS); }
        if (linked) d.onLabelsChanged();
    }

    // --- mark missed -------------------------------------------------------------------------

    function setMarking(on) {
        marking = !!on && !!set;
        if (!marking) markId = null;
        const b = $('markMissed');
        if (b) { b.setAttribute('aria-pressed', String(marking)); b.textContent = marking ? '✚ Marking: click on the video' : '✚ Mark missed'; }
        const st = document.getElementById('stage');
        if (st) st.classList.toggle('marking', marking);
        renderAll();
        d.render();
    }

    // A click on the video in mark mode: a point of the object being marked (or a new one, or
    // the label whose path is near). Returns true when it was taken.
    function markClick(e) {
        if (!marking || !set) return false;
        if (d.busy && d.busy()) return true;          // a jump still refilling: not the frame shown yet
        const { r, slot, geometry: g } = d.current();
        const p = d.toFrame(e);
        if (!g || !p) return false;
        const s = g.scale || 1;
        const px = p[0] * g.w - 0.5, py = p[1] * g.h - 0.5;
        const t = slot && slot.meta ? slot.meta.time : r ? r.time : null;
        if (!Number.isFinite(t)) return false;
        // snapped to the nearest candidate (strong, weak or dropped) close to the click
        let best = null, bd = Math.max(2, SNAP_PX * s);
        if (r && r.detect) for (const c of [...(r.candidates || []), ...(r.detect.weak || []), ...(r.detect.rejected || [])]) {
            const dd = Math.hypot(c.cx - px, c.cy - py);
            if (dd <= bd) { bd = dd; best = c; }
        }
        const cx = best ? best.cx : px, cy = best ? best.cy : py;
        const key = [t, toSrc(cx, s), toSrc(cy, s), best ? best.w / s : MARK_SIZE, best ? best.h / s : MARK_SIZE];
        let id = markId && set.objects.some(o => o.id === markId) ? markId : null;
        if (!id) {
            const near = labelAt(set, t, key[1], key[2], { radius: o => extendRadius(o.size), slack: 1 });
            id = near ? near.id : newLabelId();
        }
        const existing = set.objects.find(o => o.id === id);
        upsertObject(set, { id, label: existing ? existing.label : 'real', source: existing ? existing.source : 'marked',
            size: existing ? undefined : [key[3], key[4]], keys: [key] });
        markId = id;
        marks.push({ id, t });
        // a crop at the point (marked objects have no track to take them from)
        const pipe = d.pipeline();
        const list = labelCrops.get(id) || [];
        if (pipe && list.length < CROPS_MAX && r && Math.abs(r.time - t) < 1e-6) {
            const rgba = pipe.crop(cx, cy);
            if (rgba) {
                list.push({ name: `${id}-m${Math.round(t * 1000)}`, rgba, saved: false });
                labelCrops.set(id, list);
                const o = set.objects.find(x => x.id === id);
                o.crops = [...new Set([...o.crops, list[list.length - 1].name])].slice(0, 16);
            }
        }
        changed();
        d.render();
        return true;
    }

    function markNew() { markId = null; renderAll(); }

    function markUndo() {
        const m = marks.pop();
        if (!m || !set) return;
        const o = removeKeyAt(set, m.id, m.t);
        if (!o && markId === m.id) markId = null;
        changed();
        d.render();
    }

    // --- drawing -----------------------------------------------------------------------------

    // Labels on the overlay (processing px): their path around the frame shown and a box where
    // they are now. Real green, not an object grey, marked ones dashed cyan.
    function draw(ctx, tf, t, g) {
        if (!set || !g || !Number.isFinite(t) || !(d.params.showLabels || marking)) return;
        const s = g.scale || 1;
        for (const o of set.objects) {
            const p = interpolate(o.keys, t, 0.05);
            const keys = o.keys.filter(k => Math.abs(k[0] - t) <= PATH_WINDOW);
            if (!p && !keys.length) continue;
            const colour = o.source === 'marked' ? COLOURS.marked : COLOURS[o.label];
            ctx.strokeStyle = ctx.fillStyle = colour;
            ctx.lineWidth = (o.id === markId ? 2 : 1.25) * tf.dpr;
            ctx.setLineDash(o.source === 'marked' ? [4 * tf.dpr, 3 * tf.dpr] : []);
            // the path near now (keyframes, plus where it is now)
            const pts = [...keys.map(k => [k[0], k[1], k[2]]), ...(p ? [[t, p[0], p[1]]] : [])].sort((a, b) => a[0] - b[0]);
            if (pts.length > 1) {
                ctx.globalAlpha = 0.7;
                ctx.beginPath();
                pts.forEach(([, x, y], i) => (i ? ctx.lineTo(tf.x(toProc(x, s)), tf.y(toProc(y, s))) : ctx.moveTo(tf.x(toProc(x, s)), tf.y(toProc(y, s)))));
                ctx.stroke();
                ctx.globalAlpha = 1;
            }
            for (const k of keys) if (o.source === 'marked') { ctx.beginPath(); ctx.arc(tf.x(toProc(k[1], s)), tf.y(toProc(k[2], s)), 2 * tf.dpr, 0, Math.PI * 2); ctx.fill(); }
            if (p) {
                const half = Math.max(9 * tf.dpr, (Math.max(p[2], p[3]) * s / 2 + 3) * tf.s);
                const cx = tf.x(toProc(p[0], s)), cy = tf.y(toProc(p[1], s));
                ctx.strokeRect(cx - half, cy - half, 2 * half, 2 * half);
                ctx.font = `600 ${10 * tf.dpr}px system-ui, sans-serif`;
                ctx.textBaseline = 'top';
                ctx.fillText(o.label === 'not' ? '✗' : '✓', cx + half + 2 * tf.dpr, cy - half);
            }
        }
        ctx.setLineDash([]);
    }

    // --- panels ------------------------------------------------------------------------------

    function statusText() {
        if (!set) return { text: d.source() && d.source().isLive ? 'No labels for live sources.' : 'Open a video to label its objects.', warn: false };
        if (state.saving) return { text: 'Saving…', warn: false };
        if (state.error) return { text: `Not saved: ${state.error}`, warn: true };
        const n = set.objects.length;
        if (store.usable) return { text: dirty ? 'Changes not saved yet…' : state.saved || state.from === 'folder' ? `Saved in the data folder “${store.folderName}”${state.saved ? ` · ${state.saved.toLocaleTimeString()}` : ''}` : `Labels are saved in the data folder “${store.folderName}”.`, warn: false };
        if (store.access === 'prompt') return { text: `Kept in this browser until the data folder “${store.folderName}” is allowed again.`, warn: true };
        const nb = changedSince(set, state.exported);
        return { text: `Kept in this browser${n ? (nb ? ` · ${nb} not backed up: Export them (Settings → Data folder)${folderSupported() ? ', or pick a data folder' : ''}` : ' · exported') : ''}.`, warn: nb > 0 };
    }

    function renderStatus() {
        const st = statusText();
        const el = $('labelsStatus');
        el.textContent = st.text;
        el.classList.toggle('warn', st.warn);
        $('labelsPick').hidden = !(set && folderSupported() && store.access === 'none');
        $('labelsAllow').hidden = !(set && store.access === 'prompt');
        renderData();
    }

    function renderAll() {
        const c = counts(set);
        $('labelCounts').textContent = set ? `· ${c.real} real, ${c.not} not${c.marked ? ` (${c.marked} marked)` : ''}` : '';
        $('labelsComplete').disabled = !set;
        $('labelsComplete').checked = !!(set && set.complete);
        $('markMissed').disabled = !set;
        $('markNew').disabled = !(marking && markId);
        $('markUndo').disabled = !(marking && marks.length);
        $('exportLabels').disabled = !set;
        renderStatus();
    }

    async function renderData() {
        const el = $('dataStatus');
        const a = store.access;
        $('pickFolder').hidden = a === 'unsupported';
        $('pickFolder').textContent = store.folderName ? 'Pick another folder…' : 'Pick a folder…';
        $('allowFolder').hidden = a !== 'prompt';
        $('forgetFolder').hidden = !store.folderName;
        el.classList.toggle('warn', a === 'prompt' || a === 'denied');
        el.textContent = a === 'unsupported' ? 'This browser can\'t save into a folder: labels are kept in the browser. Export them to keep a copy; Chrome or Edge can use a data folder.'
            : a === 'none' ? 'No data folder: labels are kept in this browser. Pick a folder to keep them as files.'
            : a === 'prompt' ? `“${store.folderName}”: the browser asks again each visit. Allow access to read and save labels there.`
            : a === 'denied' ? `Access to “${store.folderName}” was refused: labels are kept in this browser.`
            : `Labels are saved in “${store.folderName}” (labels/, crops/).`;
    }

    async function renderBrowserData() {
        const list = await store.browserClips();
        const est = await store.estimate();
        const pending = list.filter(c => c.pending).length;
        $('browserData').textContent = `In this browser: ${list.length} clip${list.length === 1 ? '' : 's'} with labels${pending && store.usable ? ` (${pending} waiting for the folder)` : ''}${est && est.usage !== undefined ? ` · ${(est.usage / 1048576).toFixed(1)} MB used by this site` : ''}.`;
    }

    // --- export / import ---------------------------------------------------------------------

    async function exportLabels() {
        if (!set) return;
        await flush();
        const out = JSON.parse(JSON.stringify(set));
        const images = {};
        for (const o of set.objects) {
            for (const name of o.crops) {
                const mem = (labelCrops.get(o.id) || []).find(c => c.name === name);
                const blob = mem ? await cropToPng(mem.rgba) : await store.loadCrop(set.clip, name);
                if (blob) images[name] = await blobToDataUrl(blob);
            }
        }
        if (Object.keys(images).length) out.crops = images;
        d.download(labelsFileName(set.clip), out);
        state.exported = new Date().toISOString();
        await store.markExported(set.clip.id, state.exported);
        renderAll();
    }

    const blobToDataUrl = blob => new Promise(resolve => { const fr = new FileReader(); fr.onload = () => resolve(fr.result); fr.readAsDataURL(blob); });
    const dataUrlToBlob = async url => (await fetch(url)).blob();

    // Labels files: merged into what is kept for their clip (this one or another).
    async function importFiles(files) {
        let n = 0, bad = 0;
        for (const f of files) {
            let raw;
            try { raw = JSON.parse(await f.text()); } catch { bad++; continue; }
            const incoming = normalizeLabelSet(raw);
            if (!incoming) { bad++; continue; }
            const blobs = {};
            for (const [name, url] of Object.entries(raw.crops || {})) if (/^[\w.-]+$/.test(name) && /^data:image\/png;base64,/.test(url)) blobs[name] = await dataUrlToBlob(url);
            if (set && incoming.clip.id === set.clip.id) {
                mergePending();
                set = mergeLabelSets(set, incoming);
                dirty = true;
                await savingP;
                await store.saveClip(JSON.parse(JSON.stringify(set)), blobs).then(w => { state.where = w; dirty = false; state.saved = new Date(); }).catch(e => { state.error = e.message; });
                relinkAll();
            } else {
                const kept = await store.loadClip(incoming.clip);
                await store.saveClip(mergeLabelSets(kept.set, incoming), blobs);
            }
            n++;
        }
        renderAll();
        await renderBrowserData();
        d.render();
        return { imported: n, bad };
    }

    // after the labels changed under the objects (import): objects drop links to labels gone
    function relinkAll() {
        for (const o of objs.list()) if (o.labelId && !set.objects.some(l => l.id === o.labelId)) objs.setLabelId(o.id, null);
        d.onLabelsChanged();
    }

    // --- from the Benchmark tab -----------------------------------------------------------------

    // A track of a benchmark run ([[t, x, y, w, h], …], source px) labelled: a new label from its path.
    function addFromTrack(label, pts) {
        if (!set || !pts.length) return null;
        const med = i => [...pts.map(p => p[i])].sort((a, b) => a - b)[pts.length >> 1];
        const o = upsertObject(set, { id: newLabelId(), label, source: 'tracked', size: [med(3), med(4)], keys: simplify(pts) });
        changed();
        d.render();
        return o.id;
    }

    // Sightings of the object before its label started (a set found it earlier): added to it.
    function extendLabel(id, pts) {
        if (!set || !set.objects.some(o => o.id === id)) return;
        upsertObject(set, { id, keys: pts });
        changed();
        d.render();
    }

    // --- bookmarks ---------------------------------------------------------------------------

    const bookmarks = () => (set ? set.bookmarks : []);
    function setBookmarks(list) {
        if (!set) return;
        set.bookmarks = normalizeBookmarks(list);
        set.changed = new Date().toISOString();
        changed();
    }

    // --- binding -----------------------------------------------------------------------------

    function bind() {
        $('markMissed').addEventListener('click', () => setMarking(!marking));
        $('markNew').addEventListener('click', markNew);
        $('markUndo').addEventListener('click', markUndo);
        $('labelsComplete').addEventListener('change', e => {
            if (!set) return;
            set.complete = e.target.checked;
            set.changed = new Date().toISOString();
            changed();
        });
        const afterAccess = async () => {
            if (set) {
                const kept = await store.loadClip(set.clip).catch(() => ({ set: null }));
                mergePending();
                if (kept.set) set = mergeLabelSets(kept.set, set);
                dirty = true;
                await flush();
                relinkAll();
            }
            renderAll();
            renderBrowserData();
            d.render();
        };
        const pick = async () => {
            try { await store.pickFolder(); } catch (e) { if (e.name !== 'AbortError') { state.error = e.message; renderAll(); } return; }
            await afterAccess();
        };
        $('pickFolder').addEventListener('click', pick);
        $('labelsPick').addEventListener('click', pick);
        const allow = async () => { try { await store.allow(); } catch (e) { state.error = e.message; } await afterAccess(); };
        $('allowFolder').addEventListener('click', allow);
        $('labelsAllow').addEventListener('click', allow);
        $('forgetFolder').addEventListener('click', async () => { await store.forgetFolder(); renderAll(); });
        $('exportLabels').addEventListener('click', exportLabels);
        $('importLabels').addEventListener('click', () => $('labelsFile').click());
        $('labelsFile').addEventListener('change', async e => {
            const files = [...e.target.files];
            e.target.value = '';
            const r = await importFiles(files);
            const el = $('browserData');
            el.textContent = `Imported ${r.imported} labels file${r.imported === 1 ? '' : 's'}${r.bad ? `; ${r.bad} not a PixelHunter labels file` : ''}. ` + el.textContent;
        });
        // unsaved changes when the page goes away: written to browser storage at least
        window.addEventListener('pagehide', () => { if (dirty) flush(); });
        document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && dirty) flush(); });
    }

    async function init() {
        bind();
        await store.init();
        renderAll();
        renderBrowserData();
    }

    return {
        init,
        openClip,
        noteFrame,
        onLabel,
        draw,
        markClick,
        setMarking,
        get marking() { return marking; },
        bookmarks,
        setBookmarks,
        addFromTrack,
        extendLabel,
        flush,
        exportLabels,
        importFiles,
        // objects forgotten (Clear): their crops go too; labels stay
        clearObjects() { crops.clear(); },
        get set() { return set; },
        get store() { return store; },
        get dirty() { return dirty; },
        get status() { return statusText().text; },
        get markId() { return markId; },
        CROP,
    };
}
