// The objects UI: the list in the side panel (zoomed thumbnails, status, pin), the inspector
// (a live zoom that follows the object, its numbers and small charts, Keep tracking / Not an
// object / first and last seen / history), a card for each new object over the video, one lane
// per object on the timeline, and the history drawer under the player. The data comes from
// objects.js; this module only draws it and turns clicks into calls back to main.js.

import { historyCsv, objectsCsv } from './objects.js';

const PIN = '#ff9f43', LIVE = '#ff4fd8';
const THUMB = 64;                  // px, stored thumbnail size
const CARD_MS = 8000;              // a card stays this long (paused while hovered)
const CARDS_MAX = 3;
const LANES = 6;                   // objects shown on the timeline
const LANES_H = 12;                // px: the strip under the timeline, always this tall
const laneH = n => Math.min(4, LANES_H / Math.max(1, n));   // px per lane (with a 1 px gap from 3)
const ZOOMS = [4, 8, 16];
const SPARK_FRAMES = 150;
const STATE_KEY = 'pixelhunter.objectsView.v1';

export function createObjectsView(d) {
    // d: { objs, params, $, fmtTime, display, stage, wrap, current() → { r, slot, geometry, loop },
    //      goToTime(t), togglePin(oid), onChange(), pause(), download(name, data), sourceLabel(),
    //      exportMeta() }
    const { objs, $ } = d;
    const thumbs = new Map();          // oid → canvas (THUMB × THUMB)
    let filter = 'all';
    let open = null;                   // oid in the inspector
    let historyOf = null;              // oid in the history drawer
    let maxTime = -Infinity;           // latest media time processed: newer frames are new footage
    let dirty = true;
    // new objects playback was paused for (pause on a new object): once all of them are marked
    // "Not an object", playback resumes; any play / pause / step / seek by hand forgets them
    let pausedFor = null;
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(STATE_KEY) || '{}') || {}; } catch { /* defaults */ }
    let zoom = ZOOMS.includes(saved.zoom) ? saved.zoom : 8;
    const remember = () => { try { localStorage.setItem(STATE_KEY, JSON.stringify({ zoom, pos: saved.pos })); } catch { /* not kept */ } };

    // --- status --------------------------------------------------------------------------

    function trackOf(o) {
        const { r } = d.current();
        return r && o.trackId !== null ? r.tracks.find(t => t.id === o.trackId) || null : null;
    }

    // { key, text } for an object now: on screen, watching, out of view, lost, not an object
    function statusOf(o) {
        if (o.label === 'not') return { key: 'not', text: 'not an object' };
        const t = trackOf(o), g = d.current().geometry;
        if (!t) return { key: 'lost', text: o.lost ? `lost: ${o.lost}` : 'lost' };
        if (t.state === 'confirmed' && t.matched) return { key: 'live', text: 'on screen' };
        const [x, y] = t.lastSeen;
        const inView = g && x >= 0 && y >= 0 && x <= g.w - 1 && y <= g.h - 1;
        return inView ? { key: 'watching', text: 'watching' } : { key: 'out', text: 'out of view' };
    }

    const sizeText = o => { const c = Math.round(o.contrast); return `${o.w.toFixed(0)}×${o.h.toFixed(0)} px · ${c > 0 ? '+' : ''}${c} grey`; };

    // --- thumbnails ------------------------------------------------------------------------

    // The object's look in the frame just processed (colour, processing px), square around its box.
    function capture(oid, src, box) {
        let c = thumbs.get(oid);
        if (!c) { c = document.createElement('canvas'); c.width = c.height = THUMB; thumbs.set(oid, c); }
        const side = Math.max(16, Math.ceil(3 * Math.max(box.w, box.h)));
        const ctx = c.getContext('2d');
        ctx.imageSmoothingEnabled = false;
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, THUMB, THUMB);
        ctx.drawImage(src, Math.round(box.cx - side / 2), Math.round(box.cy - side / 2), side, side, 0, 0, THUMB, THUMB);
    }

    function drawThumb(canvas, oid) {
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = false;
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        const t = thumbs.get(oid);
        if (t) ctx.drawImage(t, 0, 0, canvas.width, canvas.height);
    }

    // --- per frame -------------------------------------------------------------------------

    // After objs.update: thumbnails of the best sightings, cards for new objects (only on footage
    // not seen before: replaying after ‹ Back or a seek confirms the same things again).
    function noteFrame(r, slot, { created, improved }) {
        const fresh = r.time > maxTime + 1e-6;
        if (fresh) maxTime = r.time;
        const byOid = new Map();
        for (const t of r.tracks) if (t.matched && t.box) { const oid = objs.objectOfTrack(t.id); if (oid !== null) byOid.set(oid, t.box); }
        for (const oid of new Set([...improved, ...created])) {
            const box = byOid.get(oid);
            if (box && slot && slot.view) capture(oid, slot.view.canvas, box);
        }
        if (fresh && created.length) {
            const shown = created.filter(oid => !objs.isHidden(oid));
            if (shown.length && d.params.cards) for (const oid of shown) addCard(oid);
            // open the newest in the inspector, unless it shows an object being kept track of
            if (shown.length && d.params.autoInspect && (open === null || !objs.isPinned(open))) inspect(shown[shown.length - 1]);
            if (shown.length && d.params.pauseOnNew) {
                if (d.pause()) pausedFor = new Set(shown);
                else if (pausedFor) for (const oid of shown) pausedFor.add(oid);
            }
        }
        dirty = true;
    }

    // --- the list ----------------------------------------------------------------------------

    function visible() {
        const all = objs.list().filter(o => o.last);
        if (filter === 'hidden') return all.filter(o => o.label === 'not');
        const shown = all.filter(o => o.label !== 'not');
        if (filter === 'pinned') return shown.filter(o => objs.isPinned(o.id));
        if (filter === 'live') return shown.filter(o => statusOf(o).key === 'live');
        return shown;
    }

    function renderFilter() {
        const host = $('objFilter');
        host.replaceChildren(...[['all', 'All'], ['live', 'Live'], ['pinned', 'Tracking'], ['hidden', 'Hidden']].map(([k, text]) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.dataset.filter = k;
            b.textContent = text;
            b.setAttribute('aria-pressed', String(filter === k));
            b.addEventListener('click', () => { filter = k; renderFilter(); dirty = true; renderList(); });
            return b;
        }));
    }

    function renderList(force = false) {
        if (!dirty && !force) return;
        dirty = false;
        const list = visible();
        $('objectList').replaceChildren(...list.map(o => {
            const li = document.createElement('li');
            const pin = objs.isPinned(o.id), st = statusOf(o);
            li.className = `${pin ? 'pinned' : ''} ${st.key === 'live' ? 'live' : ''} ${open === o.id ? 'open' : ''} ${o.label === 'not' ? 'hidden-obj' : ''}`;
            li.title = 'Inspect: zoom, numbers, keep tracking';
            li.dataset.oid = o.id;
            const thumb = document.createElement('canvas');
            thumb.className = 'thumb';
            thumb.width = thumb.height = 52;
            drawThumb(thumb, o.id);
            const head = document.createElement('div');
            head.className = 'ohead';
            const id = document.createElement('span');
            id.className = 'oid mono';
            id.textContent = `#${o.id}`;
            const chip = document.createElement('span');
            chip.className = `chip ${st.key}`;
            chip.textContent = st.key === 'lost' ? 'lost' : st.text;
            chip.title = st.text;
            head.append(id, chip);
            const size = document.createElement('span');
            size.className = 'osize mono';
            size.textContent = `${sizeText(o)} · ${o.speed.toFixed(1)} px/f`;
            const data = document.createElement('span');
            data.className = 'odata mono';
            data.textContent = `${d.fmtTime(o.first.time)}–${d.fmtTime(o.last.time)} · ${o.frames} frames`;
            const buttons = document.createElement('span');
            buttons.className = 'obtn';
            const hist = document.createElement('button');
            hist.type = 'button';
            hist.textContent = '≡';
            hist.title = 'History: size, contrast, speed and why it was missed, frame by frame';
            hist.addEventListener('click', e => { e.stopPropagation(); showHistory(historyOf === o.id ? null : o.id); });
            const pb = document.createElement('button');
            pb.type = 'button';
            pb.className = 'pin';
            pb.textContent = pin ? '★' : '☆';
            pb.title = pin ? 'Stop tracking' : 'Keep tracking: kept watching when it stops or leaves the view, drawn in orange';
            pb.addEventListener('click', e => { e.stopPropagation(); d.togglePin(o.id); });
            buttons.append(hist, pb);
            li.append(thumb, head, buttons, size, data);
            li.addEventListener('click', () => inspect(o.id));
            return li;
        }));
        $('objectsEmpty').hidden = list.length > 0;
        $('objectsEmpty').textContent = filter === 'all' ? 'No confirmed objects yet' : 'None';
        const live = objs.list().filter(o => o.label !== 'not' && statusOf(o).key === 'live').length;
        $('objBadge').hidden = !live;
        $('objBadge').textContent = String(live);
        const any = objs.list().length > 0;
        $('exportObjects').disabled = !any;
        renderHistory();
        renderLanes();
        updateInspector();
    }

    // --- the inspector ---------------------------------------------------------------------

    function inspect(oid) {
        open = oid;
        const box = $('inspector');
        box.hidden = oid === null;
        if (saved.pos && oid !== null) place(saved.pos.right, saved.pos.top);
        dirty = true;
        renderList();
        d.onChange();
    }

    function place(right, top) {
        const box = $('inspector'), wrap = d.stage.getBoundingClientRect();
        const w = box.offsetWidth || 252, h = box.offsetHeight || 400;
        right = Math.min(Math.max(0, right), Math.max(0, wrap.width - w));
        top = Math.min(Math.max(0, top), Math.max(0, wrap.height - Math.min(h, wrap.height)));
        box.style.right = `${right}px`;
        box.style.top = `${top}px`;
        return { right, top };
    }

    // Wide screens: the inspector floats over the video (inside the stage); narrow ones: it goes
    // under the player and its controls, in the flow.
    function bindPlacement() {
        const mq = window.matchMedia('(max-width: 860px)');
        const put = () => {
            const box = $('inspector');
            if (mq.matches) { if (box.parentElement !== d.wrap) d.wrap.insertBefore(box, $('objectHistory')); }
            else if (box.parentElement !== d.stage) d.stage.append(box);
        };
        put();
        mq.addEventListener('change', put);
    }

    function bindDrag() {
        const head = document.querySelector('.insp-head');
        let from = null;
        head.addEventListener('pointerdown', e => {
            if (e.target.closest('button') || getComputedStyle($('inspector')).position !== 'absolute') return;
            const box = $('inspector');
            from = { x: e.clientX, y: e.clientY, right: parseFloat(box.style.right) || 8, top: parseFloat(box.style.top) || 8 };
            head.setPointerCapture(e.pointerId);
        });
        head.addEventListener('pointermove', e => {
            if (!from) return;
            saved.pos = place(from.right - (e.clientX - from.x), from.top + (e.clientY - from.y));
        });
        const end = () => { if (from) { from = null; remember(); } };
        head.addEventListener('pointerup', end);
        head.addEventListener('pointercancel', end);
    }

    function renderZoomLevels() {
        $('inspZoomLevel').replaceChildren(...ZOOMS.map(z => {
            const b = document.createElement('button');
            b.type = 'button';
            b.textContent = `×${z}`;
            b.setAttribute('aria-pressed', String(z === zoom));
            b.addEventListener('click', () => { zoom = z; remember(); renderZoomLevels(); updateInspector(); });
            return b;
        }));
    }

    // Where the object is in the frame shown (processing px) and its box, or null.
    function whereNow(o) {
        const t = trackOf(o), g = d.current().geometry;
        if (!t || !g) return null;
        const box = t.matched && t.box ? t.box : null;
        const [x, y] = box ? [box.cx, box.cy] : t.lastSeen;
        if (x < 0 || y < 0 || x > g.w - 1 || y > g.h - 1) return null;
        return { x, y, box, seen: !!box };
    }

    function updateInspector() {
        if (open === null) return;
        const o = objs.get(open);
        if (!o) { inspect(null); return; }
        const st = statusOf(o), pin = objs.isPinned(o.id);
        $('inspTitle').textContent = `#${o.id}`;
        $('inspStatus').className = `chip ${st.key}`;
        $('inspStatus').textContent = st.key === 'lost' ? 'lost' : st.text;
        $('inspStatus').title = st.text;
        $('inspector').classList.toggle('pinned-obj', pin);
        $('inspPin').textContent = pin ? '★ Tracking' : '☆ Keep tracking';
        $('inspPin').setAttribute('aria-pressed', String(pin));
        $('inspPin').title = pin ? 'Stop keeping track of it' : 'Keep tracking: kept watching when it stops or leaves the view; labelled as an object';
        $('inspNot').setAttribute('aria-pressed', String(o.label === 'not'));
        $('inspNot').textContent = o.label === 'not' ? 'Hidden: undo' : 'Not an object';
        drawZoom(o);
        drawData(o, st);
        drawSpark(o);
    }

    function drawZoom(o) {
        const c = $('inspZoom'), ctx = c.getContext('2d'), W = c.width;
        ctx.imageSmoothingEnabled = false;
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, W, W);
        const at = whereNow(o);
        const note = $('inspNote');
        if (!at || !d.display.width) {
            // not in this frame: its best sighting
            const t = thumbs.get(o.id);
            if (t) ctx.drawImage(t, 0, 0, W, W);
            note.hidden = false;
            note.textContent = o.best ? `Not in this frame · best sighting ${d.fmtTime(o.best.time)} #${o.best.frame}` : 'Not in this frame';
            return;
        }
        note.hidden = at.seen;
        if (!at.seen) note.textContent = 'Not seen in this frame: where it was last seen';
        const side = W / zoom;
        const sx = at.x + 0.5 - side / 2, sy = at.y + 0.5 - side / 2;
        ctx.drawImage(d.display, sx, sy, side, side, 0, 0, W, W);
        const colour = objs.isPinned(o.id) ? PIN : LIVE;
        ctx.strokeStyle = colour;
        ctx.lineWidth = 1.5;
        if (at.box) {
            const b = at.box;
            ctx.strokeRect((b.x - sx) * zoom - 1, (b.y - sy) * zoom - 1, b.w * zoom + 2, b.h * zoom + 2);
        } else {
            ctx.setLineDash([4, 4]);
            const r = Math.max(6, 1.5 * zoom);
            ctx.strokeRect(W / 2 - r, W / 2 - r, 2 * r, 2 * r);
            ctx.setLineDash([]);
        }
        // scale: how many source px the view spans
        const g = d.current().geometry;
        ctx.fillStyle = 'rgb(0 0 0 / 0.6)';
        ctx.fillRect(4, W - 18, 70, 14);
        ctx.fillStyle = '#d8dde2';
        ctx.font = '10px ui-monospace, monospace';
        ctx.fillText(`${Math.round(side / (g ? g.scale : 1))} px wide`, 8, W - 7);
    }

    function drawData(o, st) {
        const seen = o.history.filter(e => e.seen && !e.event);
        const last = seen[seen.length - 1];
        const tracks = [...new Set(o.history.filter(e => e.track !== undefined).map(e => e.track))];
        const rows = [
            ['Status', st.text],
            ['Size', `${o.w.toFixed(1)}×${o.h.toFixed(1)} px`],
            ['Contrast', `${Math.round(o.contrast) > 0 ? '+' : ''}${Math.round(o.contrast) || 0} grey`],
            ['Speed', `${o.speed.toFixed(2)} px/frame`],
            ...(last && last.score !== undefined ? [['Strength', `${last.score}σ`]] : []),
            ['First seen', `${d.fmtTime(o.first.time)} #${o.first.frame ?? '–'}`],
            ...(o.confirmedAt && o.confirmedAt.frame !== o.first.frame ? [['Confirmed', `${d.fmtTime(o.confirmedAt.time)} #${o.confirmedAt.frame}`]] : []),
            ['Last seen', `${d.fmtTime(o.last.time)} #${o.last.frame}`],
            ['Seen', `${o.frames} frames`],
            ['Tracks', tracks.map(t => `#${t}`).join(' ')],
        ];
        $('inspData').replaceChildren(...rows.flatMap(([k, v]) => {
            const dt = document.createElement('dt');
            dt.textContent = k;
            const dd = document.createElement('dd');
            dd.textContent = v;
            dd.title = v;
            return [dt, dd];
        }));
    }

    // Contrast, speed and strength over the last SPARK_FRAMES rows, one small chart each.
    function drawSpark(o) {
        const c = $('inspSpark'), ctx = c.getContext('2d');
        const dpr = window.devicePixelRatio || 1, cw = Math.round(c.clientWidth * dpr) || c.width, ch = Math.round(c.clientHeight * dpr) || c.height;
        if (c.width !== cw || c.height !== ch) { c.width = cw; c.height = ch; }
        ctx.clearRect(0, 0, cw, ch);
        const rows = o.history.filter(e => !e.event).slice(-SPARK_FRAMES);
        const series = [['contrast', e => (e.contrast === undefined ? null : Math.abs(e.contrast)), 'grey'], ['speed', e => e.speed ?? null, 'px/f'], ['σ', e => e.score ?? null, '']];
        const h = ch / 3, labelW = 52 * dpr;
        ctx.font = `${10 * dpr}px ui-monospace, monospace`;
        ctx.textBaseline = 'middle';
        series.forEach(([name, get, unit], i) => {
            const y0 = i * h, vals = rows.map(e => (e.seen ? get(e) : null));
            const nums = vals.filter(v => v !== null && Number.isFinite(v));
            ctx.fillStyle = '#8b939c';
            ctx.fillText(name, 0, y0 + h / 2);
            const lastV = nums.length ? nums[nums.length - 1] : null;
            ctx.fillStyle = '#e6e8ea';
            const txt = lastV === null ? '–' : `${+lastV.toFixed(1)}${unit ? ' ' + unit : ''}`;
            ctx.textAlign = 'right';
            ctx.fillText(txt, cw, y0 + h / 2);
            ctx.textAlign = 'left';
            if (nums.length < 2) return;
            const lo = Math.min(...nums), hi = Math.max(...nums), span = hi - lo || 1;
            const x0 = labelW, x1 = cw - 64 * dpr, n = Math.max(2, rows.length);
            ctx.strokeStyle = objs.isPinned(o.id) ? PIN : LIVE;
            ctx.lineWidth = 1.25 * dpr;
            ctx.beginPath();
            let pen = false;
            vals.forEach((v, k) => {
                if (v === null || !Number.isFinite(v)) { pen = false; return; }
                const x = x0 + (x1 - x0) * k / (n - 1), y = y0 + h - 3 * dpr - (h - 6 * dpr) * (v - lo) / span;
                if (pen) ctx.lineTo(x, y); else ctx.moveTo(x, y);
                pen = true;
            });
            ctx.stroke();
        });
    }

    function bindInspector() {
        renderZoomLevels();
        bindPlacement();
        bindDrag();
        $('inspClose').addEventListener('click', () => inspect(null));
        $('inspPin').addEventListener('click', () => {
            if (open === null) return;
            const pinNow = !objs.isPinned(open);
            if (pinNow) objs.label(open, 'object');
            d.togglePin(open);
        });
        $('inspNot').addEventListener('click', () => {
            if (open === null) return;
            const o = objs.get(open);
            objs.label(open, o.label === 'not' ? null : 'not');
            if (o.label === 'not') dismissed(open);
            d.togglePin(open, objs.isPinned(open));          // keeps the tracker's pins in step
            dirty = true;
            renderList();
            d.onChange();
        });
        $('inspFirst').addEventListener('click', () => { const o = objs.get(open); if (o) d.goToTime(o.first.time); });
        $('inspLast').addEventListener('click', () => { const o = objs.get(open); if (o) d.goToTime(o.last.time); });
        $('inspHistory').addEventListener('click', () => showHistory(historyOf === open ? null : open));
    }

    // An object marked "Not an object": if playback paused for it (and only for new objects
    // dismissed the same way), it plays on.
    function dismissed(oid) {
        if (!pausedFor || !pausedFor.delete(oid) || pausedFor.size) return;
        pausedFor = null;
        d.resume();
    }

    // --- cards for new objects ---------------------------------------------------------------

    function addCard(oid) {
        const o = objs.get(oid);
        if (!o) return;
        const host = $('cards');
        while (host.children.length >= CARDS_MAX) host.firstElementChild.remove();
        const card = document.createElement('div');
        card.className = 'card';
        card.dataset.oid = oid;
        card.title = 'Inspect it';
        const thumb = document.createElement('canvas');
        thumb.width = thumb.height = 56;
        drawThumb(thumb, oid);
        const title = document.createElement('span');
        title.className = 'ctitle';
        title.textContent = `#${oid} · new object`;
        const data = document.createElement('span');
        data.className = 'cdata mono';
        data.textContent = `${sizeText(o)} · ${d.fmtTime(o.confirmedAt ? o.confirmedAt.time : o.first.time)}`;
        const btns = document.createElement('div');
        btns.className = 'cbtns';
        const keep = document.createElement('button');
        keep.type = 'button';
        keep.textContent = '☆ Keep tracking';
        keep.addEventListener('click', e => { e.stopPropagation(); if (!objs.isPinned(oid)) { objs.label(oid, 'object'); d.togglePin(oid); } close(); });
        const not = document.createElement('button');
        not.type = 'button';
        not.textContent = 'Not an object';
        not.addEventListener('click', e => { e.stopPropagation(); objs.label(oid, 'not'); d.togglePin(oid, false); dirty = true; renderList(); d.onChange(); close(); dismissed(oid); });
        const x = document.createElement('button');
        x.type = 'button';
        x.className = 'icon';
        x.textContent = '×';
        x.title = 'Dismiss';
        x.addEventListener('click', e => { e.stopPropagation(); close(); });
        btns.append(keep, not, x);
        card.append(thumb, title, data, btns);
        card.addEventListener('click', () => { inspect(oid); close(); });
        let timer = null;
        const arm = ms => { clearTimeout(timer); timer = setTimeout(close, ms); };
        function close() {
            clearTimeout(timer);
            if (!card.isConnected) return;
            card.classList.add('leaving');
            setTimeout(() => card.remove(), 400);
        }
        card.addEventListener('mouseenter', () => clearTimeout(timer));
        card.addEventListener('mouseleave', () => arm(3000));
        arm(CARD_MS);
        host.append(card);
    }

    // --- timeline lanes ---------------------------------------------------------------------

    let lanes = [];                    // [{ o, segs: [[t0, t1, early]] }] as drawn

    function segmentsOf(o, fd) {
        const segs = [];
        for (const e of o.history) {
            if (!e.seen || e.event || !Number.isFinite(e.time)) continue;
            const s = segs[segs.length - 1];
            if (s && e.time - s[1] <= 4 * fd + 1e-6 && e.time >= s[0]) { s[1] = e.time; if (!e.early) s[2] = false; } else segs.push([e.time, e.time, !!e.early]);
        }
        return segs;
    }

    function renderLanes() {
        const c = $('tlLanes'), { loop } = d.current();
        const dur = loop && Number.isFinite(loop.duration) && loop.duration > 0 ? loop.duration : null;
        const fps = (loop && loop.stats().sourceFps) || 25, fd = 1 / fps;
        const list = dur ? objs.list().filter(o => o.last && o.label !== 'not').sort((a, b) => (objs.isPinned(b.id) - objs.isPinned(a.id)) || (b.id === open) - (a.id === open) || b.last.time - a.last.time).slice(0, LANES) : [];
        lanes = list.map(o => ({ o, segs: segmentsOf(o, fd) }));
        const dpr = window.devicePixelRatio || 1;
        const w = Math.max(1, Math.round(c.clientWidth * dpr)), lh = laneH(lanes.length);
        const h = Math.round(LANES_H * dpr);
        if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
        const ctx = c.getContext('2d');
        ctx.clearRect(0, 0, w, h);
        lanes.forEach(({ o, segs }, i) => {
            const y = i * lh * dpr, bar = Math.max(1, (lh >= 3 ? lh - 1 : lh * 0.75)) * dpr;
            ctx.fillStyle = 'rgb(255 255 255 / 0.05)';
            ctx.fillRect(0, y, w, bar);
            const colour = objs.isPinned(o.id) ? PIN : LIVE;
            for (const [t0, t1, early] of segs) {
                ctx.globalAlpha = early ? 0.4 : o.id === open ? 1 : 0.75;
                ctx.fillStyle = colour;
                const x0 = t0 / dur * w, x1 = Math.max(x0 + 2 * dpr, (t1 + fd) / dur * w);
                ctx.fillRect(x0, y, x1 - x0, bar);
            }
            ctx.globalAlpha = 1;
        });
    }

    // The object lane under a pointer event on the lanes canvas: { o, t } or null.
    function laneAt(e) {
        const c = $('tlLanes'), rect = c.getBoundingClientRect(), { loop } = d.current();
        if (!lanes.length || !loop || !Number.isFinite(loop.duration)) return null;
        const i = Math.floor((e.clientY - rect.top) / laneH(lanes.length));
        if (i < 0 || i >= lanes.length || e.clientX < rect.left || e.clientX > rect.right) return null;
        const t = (e.clientX - rect.left) / rect.width * loop.duration;
        // the nearest segment's time, within 6 screen px
        const tol = 6 / rect.width * loop.duration;
        let best = null;
        for (const [t0, t1] of lanes[i].segs) {
            const dt = t < t0 ? t0 - t : t > t1 ? t - t1 : 0;
            if (dt <= tol && (!best || dt < best.dt)) best = { dt, t: Math.min(t1, Math.max(t0, t)) };
        }
        return best ? { o: lanes[i].o, t: best.t } : { o: lanes[i].o, t: null };
    }

    function bindLanes() {
        $('tlLanes').addEventListener('click', e => {
            const hit = laneAt(e);
            if (!hit) return;
            inspect(hit.o.id);
            if (hit.t !== null) d.goToTime(hit.t);
        });
        new ResizeObserver(() => renderLanes()).observe($('tlLanes'));
    }

    // --- history drawer -----------------------------------------------------------------------

    function showHistory(oid) {
        historyOf = oid;
        dirty = true;
        renderList();
    }

    function renderHistory() {
        const box = $('objectHistory');
        const o = historyOf !== null ? objs.get(historyOf) : null;
        box.hidden = !o;
        if (!o) return;
        const tracks = [...new Set(o.history.filter(e => e.track !== undefined).map(e => e.track))];
        $('historyTitle').textContent = `#${o.id} · tracks ${tracks.map(t => `#${t}`).join(', ')} · ${o.history.length} rows${o.label ? ` · labelled: ${o.label === 'not' ? 'not an object' : 'object'}` : ''}`;
        const rows = o.history.slice(-300).reverse();
        $('historyRows').replaceChildren(...rows.map(e => {
            const tr = document.createElement('tr');
            const cells = Array.from({ length: 9 }, () => document.createElement('td'));
            cells[0].textContent = e.frame ?? '';
            cells[1].textContent = d.fmtTime(e.time);
            if (e.event) {
                tr.className = 'ev';
                cells[8].textContent = e.event;
            } else if (e.seen) {
                if (e.early) tr.className = 'early';
                const c = e.contrast === undefined ? null : Math.round(e.contrast);
                cells[2].textContent = e.early ? 'building' : `${e.state}${e.weak ? ' weak' : ''}`;
                cells[3].textContent = `${e.w}×${e.h}`;
                cells[4].textContent = c === null ? '' : `${c > 0 ? '+' : ''}${c}`;
                cells[5].textContent = e.speed ?? '';
                cells[6].textContent = e.score ?? '';
                cells[7].textContent = `${e.x}, ${e.y}`;
                if (e.weak && !e.early) cells[8].textContent = 'weak sighting';
            } else {
                tr.className = 'miss';
                cells[2].textContent = e.state;
                cells[7].textContent = e.x !== undefined ? `${e.x}, ${e.y}` : '';
                cells[8].textContent = e.why || 'not seen';
            }
            tr.append(...cells);
            return tr;
        }));
    }

    function exportHistory(kind) {
        const o = historyOf !== null ? objs.get(historyOf) : null;
        if (!o) return;
        const base = `${d.fileBase()}.object-${o.id}`;
        if (kind === 'csv') downloadText(`${base}.csv`, historyCsv(o), 'text/csv');
        else d.download(`${base}.json`, { ...d.exportMeta(), object: o.id, label: o.label,
            units: 'x, y, w, h: source px; contrast: grey levels (box mean − 2 px ring mean); speed: px per frame against the background; score: σ (adaptive mode); early: seen before it confirmed',
            history: o.history.map(({ px, ...e }) => e) });
    }

    function downloadText(name, text, type) {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([text], { type }));
        a.download = name;
        document.body.append(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }

    // --- the rest ------------------------------------------------------------------------------

    function bind() {
        renderFilter();
        bindInspector();
        bindLanes();
        $('historyCsv').addEventListener('click', () => exportHistory('csv'));
        $('historyJson').addEventListener('click', () => exportHistory('json'));
        $('historyClose').addEventListener('click', () => showHistory(null));
        $('exportObjects').addEventListener('click', () => downloadText(`${d.fileBase()}.objects.csv`, objectsCsv(objs.list()), 'text/csv'));
    }

    return {
        bind,
        noteFrame,
        render: renderList,
        markDirty() { dirty = true; },
        // per drawn frame: the inspector's zoom follows the object
        frameDrawn() { if (open !== null) updateInspector(); },
        inspect,
        get open() { return open; },
        get historyOf() { return historyOf; },
        showHistory,
        laneAt,
        renderLanes,
        get laneCount() { return lanes.length; },
        // playback was paused or moved by hand: no automatic resume
        manual() { pausedFor = null; },
        get pausedFor() { return pausedFor ? [...pausedFor] : null; },
        // a new source or Clear: everything goes
        clear() {
            thumbs.clear();
            open = null;
            historyOf = null;
            maxTime = -Infinity;
            $('inspector').hidden = true;
            $('cards').replaceChildren();
            dirty = true;
        },
        // after ‹ Back / a seek: frames from here on are footage seen before (no cards)
        get maxTime() { return maxTime; },
        // the objects with labels, for the detections export
        summary() {
            return objs.list().map(o => ({ id: o.id, label: o.label, first: o.first, confirmed: o.confirmedAt || null, last: o.last, frames: o.frames,
                w: +o.w.toFixed(1), h: +o.h.toFixed(1), contrast: +o.contrast.toFixed(1), speed: +o.speed.toFixed(2) }));
        },
    };
}
