// Objects: what the user sees in the Objects panel, built on the tracker's tracks. Pure: no DOM,
// no OpenCV (the grey frame is passed as { cols, rows, data }).
//
// An object has its own id, separate from track ids: one object can be carried by several
// tracks in turn, when tracking loses it and a new track is re-linked to it (below). For each
// object a per-frame history is kept (size, contrast, speed, state, strength) with, for frames
// it was not seen, the likely reason why, and events (confirmed, lost, re-linked); it can be
// viewed and exported to tune settings.
//
// Re-linking (pinned objects only, the ones the user cares about):
//   - after a jump in the video (‹ Back, a bookmark, a seek) tracking restarts and the pinned
//     object's track is gone. If the history has the object at the frame now shown (within 1.5
//     frame times), a new confirmed track within RELINK_NEAR of where it was then, and of a
//     compatible look (size within RELINK_SIZE ×, contrast of the same sign), continues it;
//   - while a pinned object is being watched (its track waits where it stopped), a new
//     confirmed track that appears within RELINK_WATCH of that spot, with a compatible look,
//     continues it: the object moved off while unseen and was picked up as something new.

const HISTORY = 900;               // frames of history kept per object
const RELINK_SIZE = 2.5;           // size ratio still "the same object"
const relinkNear = o => Math.max(6, 2 * Math.max(o.w, o.h));
const relinkWatch = o => Math.max(20, 4 * Math.max(o.w, o.h));

// Mean grey inside a box minus the mean of a 2 px ring around it (grey frame, processing px).
export function contrastOf(mat, b) {
    const W = mat.cols, H = mat.rows, d = mat.data;
    let si = 0, ni = 0, sr = 0, nr = 0;
    for (let y = Math.max(0, b.y - 2); y < Math.min(H, b.y + b.h + 2); y++) {
        for (let x = Math.max(0, b.x - 2); x < Math.min(W, b.x + b.w + 2); x++) {
            const inside = x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h;
            if (inside) { si += d[y * W + x]; ni++; } else { sr += d[y * W + x]; nr++; }
        }
    }
    return ni && nr ? si / ni - sr / nr : 0;
}

// Why a track wasn't seen this frame: the nearest thing the detector found around where it was
// expected, or why there was nothing.
export function missReason(r, t, w, h) {
    if (!r.detect.ok) return `no detection this frame: ${r.detect.reason}`;
    const [px, py] = t.held ? t.lastSeen : t.predicted;
    if (px < 0 || py < 0 || px > w - 1 || py > h - 1) return 'out of view';
    const gate = t.gate ?? 8;
    const reach = Math.max(15, 3 * gate);
    let best = null;
    const look = (list, kind) => {
        for (const c of list || []) {
            const d = Math.hypot(c.cx - px, c.cy - py);
            if (d <= reach && (!best || d < best.d)) best = { c, d, kind };
        }
    };
    look(r.candidates, 'strong');
    look(r.detect.weak, 'weak');
    look(r.detect.rejected, 'dropped');
    if (!best) return 'nothing detected near (too faint, or not moving against the background)';
    const d = best.d.toFixed(1);
    if (best.kind === 'dropped') return `a candidate ${d} px away was dropped: ${best.c.why}`;
    if (best.kind === 'weak') {
        if (t.held) return `only a weak candidate ${d} px away (a waiting track needs a strong one)`;
        return `only a weak candidate, ${d} px from the prediction (weak gate ${(t.weakGate ?? gate).toFixed(1)} px)`;
    }
    return `nearest candidate ${d} px from the prediction, outside the gate (${gate.toFixed(1)} px)${best.c.taken ? '; taken by another track' : ''}`;
}

// A sighting from before the track confirmed (tracker `early`) as a history row, source px.
function earlyEntry(e, track, s) {
    const b = e.box;
    return { frame: e.frame, time: e.time, track, state: 'tentative', seen: true, early: true,
        x: +((b.cx + 0.5) / s - 0.5).toFixed(1), y: +((b.cy + 0.5) / s - 0.5).toFixed(1), w: +(b.w / s).toFixed(1), h: +(b.h / s).toFixed(1),
        speed: +(Math.hypot(e.vx, e.vy) / s).toFixed(2), ...(e.score !== undefined ? { score: +e.score.toFixed(1) } : {}),
        ...(e.weak ? { weak: true } : {}), px: [b.cx, b.cy] };
}

const compatible = (o, b, contrast) => {
    const s1 = Math.max(o.w, o.h), s2 = Math.max(b.w, b.h);
    return s1 / s2 <= RELINK_SIZE && s2 / s1 <= RELINK_SIZE && (Math.sign(contrast) === Math.sign(o.contrast) || Math.abs(o.contrast) < 4);
};

export function createObjects({ kept = 40 } = {}) {
    let objects = new Map();       // oid → object; insertion order = last update
    let byTrack = new Map();       // track id → oid
    let nextId = 1;
    const pinned = new Set();      // oids

    function event(o, r, text) {
        o.history.push({ frame: r.frame, time: r.time, event: text });
        if (o.history.length > HISTORY) o.history.shift();
    }

    function touch(o) { objects.delete(o.id); objects.set(o.id, o); }

    // r: a pipeline result; grey: the frame shown ({ cols, rows, data }, processing px);
    // frameDuration: s, for matching history to the frame now shown.
    // Returns { created: ids of objects new this frame, improved: ids whose best sighting is
    // this frame's (for a thumbnail) }.
    let fd = 1 / 25;
    function update(r, grey, { frameDuration } = {}) {
        if (frameDuration > 0) fd = frameDuration;
        const created = [], improved = [];
        const s = r.scale || 1, W = r.width, H = r.height;
        const tracks = new Map(r.tracks.map(t => [t.id, t]));
        // candidates taken by some track this frame (for the reasons)
        const taken = new Set(r.tracks.filter(t => t.matched && t.box).map(t => `${t.box.cx},${t.box.cy}`));
        for (const c of r.candidates) c.taken = taken.has(`${c.cx},${c.cy}`);

        // objects whose track has gone
        for (const [tid, oid] of [...byTrack]) {
            if (tracks.has(tid)) continue;
            byTrack.delete(tid);
            const o = objects.get(oid);
            if (!o || o.trackId !== tid) continue;
            o.trackId = null;
            o.lost = r.jump || r.frame < (o.last ? o.last.frame : 0)
                ? `tracking restarted (${r.jumpReason || 'jump in the video'})`
                : `track dropped: not seen for ${o.misses ?? '?'} frames`;
            event(o, r, `lost: ${o.lost}`);
        }

        for (const t of r.tracks) {
            let oid = byTrack.get(t.id);
            const live = t.state === 'confirmed' && t.matched;
            if (oid === undefined) {
                if (!live) continue;                          // objects start at confirmation
                const contrast = contrastOf(grey, t.box);
                const box = { w: t.box.w / s, h: t.box.h / s };
                const o = relinkTarget(r, t, box, contrast);
                if (o) {
                    const how = o.trackId === null ? 'after tracking restarted, where it was at this time' : `near where it was being watched (track #${o.trackId} let go)`;
                    if (o.trackId !== null) byTrack.delete(o.trackId);
                    event(o, r, `re-linked: track #${t.id} ${how}`);
                    o.lost = null;
                    oid = o.id;
                } else {
                    oid = nextId++;
                    // its sightings before it confirmed, back-filled (no contrast: those frames are gone)
                    const early = (t.early || []).map(e => earlyEntry(e, t.id, s));
                    const first = early.length ? { frame: early[0].frame, time: early[0].time } : { frame: r.frame, time: r.time };
                    objects.set(oid, { id: oid, trackId: t.id, first, confirmedAt: { frame: r.frame, time: r.time }, last: null, frames: 0,
                        w: box.w, h: box.h, contrast, speed: 0, best: null, label: null, history: early, lost: null });
                    event(objects.get(oid), r, `confirmed (track #${t.id})${early.length ? `, seen ${early.length} times before` : ''}`);
                    created.push(oid);
                }
                byTrack.set(t.id, oid);
                objects.get(oid).trackId = t.id;
            }
            const o = objects.get(oid);
            if (!o) continue;
            o.misses = t.misses;
            const entry = { frame: r.frame, time: r.time, track: t.id, state: t.state, seen: t.matched };
            if (t.matched && t.box) {
                const contrast = contrastOf(grey, t.box);
                Object.assign(entry, { x: +((t.box.cx + 0.5) / s - 0.5).toFixed(1), y: +((t.box.cy + 0.5) / s - 0.5).toFixed(1),
                    w: +(t.box.w / s).toFixed(1), h: +(t.box.h / s).toFixed(1), contrast: +contrast.toFixed(1), speed: +(Math.hypot(t.vx, t.vy) / s).toFixed(2) });
                const c = [...r.candidates, ...(r.detect.weak || [])].find(q => q.cx === t.box.cx && q.cy === t.box.cy);
                if (c && c.score !== undefined) entry.score = +c.score.toFixed(1);
                if (c && c.weak) entry.weak = true;
                if (live) {
                    o.last = { frame: r.frame, time: r.time };
                    o.frames++;
                    o.w = entry.w; o.h = entry.h; o.contrast = contrast; o.speed = entry.speed;
                    o.lastPos = [t.box.cx, t.box.cy];
                    // its clearest sighting so far (score, else |contrast| × area): the thumbnail's frame
                    const q = entry.score ?? Math.abs(contrast) * Math.sqrt(t.box.area || 1);
                    if (!o.best || q > o.best.q) { o.best = { q, frame: r.frame, time: r.time }; improved.push(o.id); }
                }
            } else {
                const [x, y] = t.lastSeen;
                Object.assign(entry, { x: +((x + 0.5) / s - 0.5).toFixed(1), y: +((y + 0.5) / s - 0.5).toFixed(1) });
                entry.why = missReason(r, t, W, H);
            }
            entry.px = t.matched && t.box ? [t.box.cx, t.box.cy] : t.lastSeen;   // processing px, for re-linking
            o.history.push(entry);
            if (o.history.length > HISTORY) o.history.shift();
            if (live || pinned.has(oid)) touch(o);
        }
        // forget the oldest unpinned objects
        while (objects.size > kept) {
            const old = [...objects.keys()].find(id => !pinned.has(id));
            if (old === undefined) break;
            const o = objects.get(old);
            if (o.trackId !== null) byTrack.delete(o.trackId);
            objects.delete(old);
        }
        return { created, improved };
    }

    // A pinned object a new confirmed track t should continue, or null.
    function relinkTarget(r, t, box, contrast) {
        for (const oid of pinned) {
            const o = objects.get(oid);
            if (!o || !compatible(o, box, contrast)) continue;
            if (o.trackId === null) {
                // after a jump: where was it at this time?
                let best = null;
                for (const e of o.history) {
                    if (!e.px || Math.abs(e.time - r.time) > 1.5 * fd) continue;
                    if (!best || Math.abs(e.time - r.time) < Math.abs(best.time - r.time)) best = e;
                }
                if (best && Math.hypot(best.px[0] - t.box.cx, best.px[1] - t.box.cy) <= relinkNear(o)) return o;
            } else {
                // being watched: a new track near that spot
                const held = r.tracks.find(x => x.id === o.trackId);
                if (!held || held.matched) continue;
                const [hx, hy] = held.lastSeen;
                if (Math.hypot(hx - t.box.cx, hy - t.box.cy) <= relinkWatch(o)) return o;
            }
        }
        return null;
    }

    return {
        update,
        // latest first, pinned first
        list() {
            const all = [...objects.values()].reverse();
            return [...all.filter(o => pinned.has(o.id)), ...all.filter(o => !pinned.has(o.id))];
        },
        get(oid) { return objects.get(oid) || null; },
        objectOfTrack(tid) { return byTrack.has(tid) ? byTrack.get(tid) : null; },
        isPinned(oid) { return pinned.has(oid); },
        // the user's verdict: 'object' (kept tracking) or 'not' (not an object: hidden), or null
        label(oid, value) {
            const o = objects.get(oid);
            if (!o) return null;
            if (value !== undefined && value !== o.label) {
                o.label = value;
                o.history.push({ frame: o.last ? o.last.frame : null, time: o.last ? o.last.time : null, event: value === 'not' ? 'labelled: not an object' : value === 'object' ? 'labelled: object' : 'label cleared' });
                if (value === 'not') pinned.delete(oid);
            }
            return o.label;
        },
        isHidden(oid) { const o = objects.get(oid); return !!o && o.label === 'not'; },
        pin(oid, on = !pinned.has(oid)) { if (on) pinned.add(oid); else pinned.delete(oid); return on; },
        get pinnedCount() { return pinned.size; },
        // track ids the tracker should keep watching
        pinnedTrackIds() { return [...pinned].map(oid => objects.get(oid)).filter(o => o && o.trackId !== null).map(o => o.trackId); },
        clear() { objects = new Map(); byTrack = new Map(); pinned.clear(); },
    };
}

// An object's history as CSV (one row per frame, events as rows with only `event` filled).
export function historyCsv(o) {
    const cols = ['frame', 'time', 'track', 'state', 'seen', 'early', 'x', 'y', 'w', 'h', 'contrast', 'speed', 'score', 'weak', 'why', 'event'];
    const q = v => (v === undefined || v === null ? '' : typeof v === 'string' && /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : String(v));
    return [cols.join(','), ...o.history.map(e => cols.map(c => q(e[c])).join(','))].join('\n');
}

// The objects as CSV, one row each, with the user's labels (rough ground truth for tuning).
export function objectsCsv(list) {
    const cols = ['id', 'label', 'first_frame', 'first_time', 'confirmed_frame', 'confirmed_time', 'last_frame', 'last_time', 'frames', 'w', 'h', 'contrast', 'speed'];
    const q = v => (v === undefined || v === null ? '' : String(v));
    const rows = list.map(o => [o.id, o.label, o.first.frame, o.first.time?.toFixed(3), o.confirmedAt?.frame, o.confirmedAt?.time?.toFixed(3),
        o.last?.frame, o.last?.time?.toFixed(3), o.frames, o.w?.toFixed(1), o.h?.toFixed(1), o.contrast?.toFixed(1), o.speed?.toFixed(2)].map(q).join(','));
    return [cols.join(','), ...rows].join('\n');
}
