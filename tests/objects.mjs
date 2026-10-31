// objects.js (Node): object ids over tracks, history with reasons for misses, re-linking a
// pinned object after a jump and while it is being watched.
import { ok } from './lib/env.mjs';
import { createObjects, missReason, historyCsv } from '../src/objects.js';

const W = 200, H = 100;
const grey = { cols: W, rows: H, data: new Uint8Array(W * H).fill(100) };
const box = (cx, cy, s = 3) => ({ cx, cy, x: Math.round(cx - s / 2), y: Math.round(cy - s / 2), w: s, h: s, area: s * s });
const track = (id, cx, cy, extra = {}) => ({ id, state: 'confirmed', matched: true, box: box(cx, cy), vx: 2, vy: 0, lastSeen: [cx, cy], predicted: [cx, cy], gate: 6, misses: 0, held: false, ...extra });
const result = (frame, tracks, extra = {}) => ({ frame, time: frame / 25, width: W, height: H, scale: 1, tracks, confirmed: tracks.filter(t => t.state === 'confirmed' && t.matched),
    candidates: tracks.filter(t => t.matched).map(t => ({ ...t.box, score: 9 })), detect: { ok: true, weak: [], rejected: [] }, ...extra });
// a dark dot in the grey frame where the boxes are
const paint = (cx, cy) => { grey.data.fill(100); for (let y = cy - 1; y <= cy + 1; y++) for (let x = cx - 1; x <= cx + 1; x++) grey.data[y * W + x] = 40; };

{
    const objs = createObjects();
    for (let k = 0; k < 10; k++) { paint(50 + 2 * k, 50); objs.update(result(k, [track(7, 50 + 2 * k, 50)]), grey); }
    const [o] = objs.list();
    ok('an object has its own id, for track #7', o.id === 1 && objs.objectOfTrack(7) === 1);
    ok('… size, contrast (darker: negative), speed', o.w === 3 && o.contrast < -40 && o.speed === 2, [o.w, o.contrast, o.speed]);
    ok('… a history row per frame, an event at confirmation', o.history.filter(e => !e.event).length === 10 && o.history[0].event === 'confirmed (track #7)');
    // missed: a candidate outside the gate, then a dropped one, then nothing
    const miss = (extra, cands = [], det = {}) => { const t = track(7, 70, 50, { matched: false, misses: 1, predicted: [70, 50], ...extra }); return { t, r: { ...result(10, [t]), candidates: cands, detect: { ok: true, weak: [], rejected: [], ...det } } }; };
    let m = miss({}, [box(80, 50)]);
    ok('reason: nearest candidate outside the gate', /10\.0 px from the prediction, outside the gate \(6\.0 px\)/.test(missReason(m.r, m.t, W, H)), missReason(m.r, m.t, W, H));
    m = miss({}, [], { rejected: [{ ...box(72, 50), why: 'sliver along an edge' }] });
    ok('reason: the candidate there was dropped, and why', /dropped: sliver along an edge/.test(missReason(m.r, m.t, W, H)));
    m = miss({}, [], { weak: [{ ...box(71, 50), weak: true }] });
    ok('reason: only a weak candidate', /only a weak candidate/.test(missReason(m.r, m.t, W, H)));
    m = miss({});
    ok('reason: nothing detected near', /nothing detected near/.test(missReason(m.r, m.t, W, H)));
    m = miss({}, [], { ok: false, reason: 'camera motion: too few inliers' });
    ok('reason: no detection this frame, and why', /no detection this frame: camera motion/.test(missReason(m.r, m.t, W, H)));
    m = miss({ predicted: [-20, 50] });
    ok('reason: out of view', missReason(m.r, m.t, W, H) === 'out of view');
    // the track goes (not pinned): lost, with the reason
    objs.update(result(11, []), grey);
    ok('track dropped: the object is lost, with the reason', /lost: track dropped/.test(o.history.at(-1).event) && o.trackId === null);
    ok('CSV export: a header and a row per entry', historyCsv(o).split('\n').length === o.history.length + 1 && historyCsv(o).startsWith('frame,time,track'));
}
{
    // pinned, then a jump back (tracking restarts): a new track where it was at that time continues it
    const objs = createObjects();
    for (let k = 0; k < 20; k++) objs.update(result(k, [track(3, 40 + 3 * k, 60)]), grey);
    objs.pin(1);
    objs.update(result(9, [], { jump: true, jumpReason: 'seek' }), grey);
    const o = objs.get(1);
    ok('pinned, jump: lost because tracking restarted', /tracking restarted \(seek\)/.test(o.lost), o.lost);
    objs.update(result(10, [track(41, 40 + 3 * 10 + 1, 60)]), grey);          // where it was at frame 10, 1 px off
    ok('… a new track where it was at that time continues it', objs.objectOfTrack(41) === 1 && /re-linked: track #41 after tracking restarted/.test(o.history.at(-2).event || o.history.at(-1).event), o.history.slice(-3));
    ok('… and the tracker is told to watch the new track', JSON.stringify(objs.pinnedTrackIds()) === '[41]');
    objs.update(result(11, [track(42, 150, 20)]), grey);
    ok('a track somewhere else is a new object', objs.objectOfTrack(42) === 2);
}
{
    // pinned and watched (its track waits where it stopped): a new track that appears near continues it
    const objs = createObjects();
    for (let k = 0; k < 10; k++) objs.update(result(k, [track(5, 40 + 2 * k, 60)]), grey);
    objs.pin(1);
    const waiting = track(5, 58, 60, { matched: false, state: 'held', held: true, misses: 8, lastSeen: [58, 60] });
    objs.update(result(20, [waiting]), grey);
    objs.update(result(21, [waiting, track(9, 70, 62)]), grey);                    // 12 px away
    ok('watched: a new track near the spot continues the pinned object', objs.objectOfTrack(9) === 1 && JSON.stringify(objs.pinnedTrackIds()) === '[9]');
    const big = { ...track(11, 60, 64), box: { ...box(60, 64, 14) } };
    const objs2 = createObjects();
    for (let k = 0; k < 10; k++) objs2.update(result(k, [track(5, 40 + 2 * k, 60)]), grey);
    objs2.pin(1);
    objs2.update(result(21, [waiting, big]), grey);
    ok('… but not one of a very different size', objs2.objectOfTrack(11) === 2);
}
