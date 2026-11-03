// Benchmark scoring: a run's confirmed tracks against the clip's labels (labels.js). Pure.
//
// A track (its confirmed sightings, source px) matches a label when, of its sightings inside
// the label's time span, at least MIN_INSIDE are and more than half are within
// max(4 px, 1.5 × the label's size) of the label's path. Sightings outside the span don't
// count, so a set that finds an object earlier than the labelling run isn't charged for it.
// A track matches at most one label (the one it follows best).
//   real label   → the track found it (latency: the track's first confirmed time − the label's
//                  start; negative = found earlier than labelled)
//   "not" label  → a false track
//   no label     → false when the clip is marked "all real objects labelled", else unknown
// Frame recall: of the processed frames inside real labels' spans, the share with a confirmed
// sighting on the label's path.

import { interpolate, spanOf, matchRadius } from './labels.js';

export const MIN_INSIDE = 3;
const EPS = 0.0015;                       // s: times within this are the same frame

function median(v) {
    if (!v.length) return null;
    const s = [...v].sort((a, b) => a - b);
    return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

// labels: a clip's labels; run: { times: [processed frame times], tracks: [{ id, pts: [[t, x, y,
// w, h], …] }], ms: [per-frame ms] }; fps for the minutes covered.
export function scoreRun(labels, run, { fps = 25 } = {}) {
    const objects = labels ? labels.objects : [];
    const complete = !!(labels && labels.complete);
    const spans = new Map(objects.map(o => [o.id, spanOf(o)]));
    const perLabel = new Map(objects.map(o => [o.id, { id: o.id, label: o.label, tracks: [], latency: null, earliest: null }]));
    const perTrack = [];
    for (const tr of run.tracks) {
        let best = null;
        for (const o of objects) {
            const [s0, s1] = spans.get(o.id) || [];
            if (s0 === undefined) continue;
            const r = matchRadius(o.size);
            let inside = 0, near = 0, dist = 0;
            for (const p of tr.pts) {
                if (p[0] < s0 - EPS || p[0] > s1 + EPS) continue;
                inside++;
                const q = interpolate(o.keys, p[0]);
                const dd = q ? Math.hypot(q[0] - p[1], q[1] - p[2]) : Infinity;
                if (dd <= r) { near++; dist += dd; }
            }
            if (inside < MIN_INSIDE || near * 2 <= inside) continue;
            const frac = near / inside, mean = dist / near;
            // the label it follows best: most of its sightings near, then the most, then the closest
            if (!best || frac > best.frac || (frac === best.frac && (near > best.near || (near === best.near && mean < best.mean)))) best = { o, frac, near, mean };
        }
        const first = tr.pts.length ? tr.pts[0][0] : null, last = tr.pts.length ? tr.pts[tr.pts.length - 1][0] : null;
        const verdict = best ? (best.o.label === 'real' ? 'real' : 'false') : complete ? 'false' : 'unknown';
        perTrack.push({ id: tr.id, verdict, labelId: best ? best.o.id : null, first, last, frames: tr.pts.length });
        if (best) {
            const pl = perLabel.get(best.o.id);
            pl.tracks.push(tr.id);
            const lat = first - spans.get(best.o.id)[0];
            if (pl.latency === null || lat < pl.latency) pl.latency = lat;
            if (lat < 0) {
                // its sightings before the label starts: offered to extend the label
                const before = tr.pts.filter(p => p[0] < spans.get(best.o.id)[0] - EPS);
                if (before.length && (!pl.earliest || before[0][0] < pl.earliest[0][0])) pl.earliest = before;
            }
        }
    }

    // frame recall over real labels
    const byTime = new Map();
    const tkey = t => Math.round(t * 1000);
    for (const tr of run.tracks) for (const p of tr.pts) { const k = tkey(p[0]); (byTime.get(k) || byTime.set(k, []).get(k)).push(p); }
    let labelFrames = 0, hitFrames = 0;
    for (const t of run.times) {
        for (const o of objects) {
            if (o.label !== 'real') continue;
            const q = interpolate(o.keys, t);
            if (!q) continue;
            labelFrames++;
            const r = matchRadius(o.size);
            const pts = [...(byTime.get(tkey(t)) || []), ...(byTime.get(tkey(t) - 1) || []), ...(byTime.get(tkey(t) + 1) || [])];
            if (pts.some(p => Math.abs(p[0] - t) <= EPS && Math.hypot(q[0] - p[1], q[1] - p[2]) <= r)) hitFrames++;
        }
    }

    const reals = objects.filter(o => o.label === 'real');
    const found = reals.filter(o => perLabel.get(o.id).tracks.length).length;
    const lats = reals.map(o => perLabel.get(o.id).latency).filter(v => v !== null);
    const falseTracks = perTrack.filter(t => t.verdict === 'false').length;
    const unknown = perTrack.filter(t => t.verdict === 'unknown').length;
    const minutes = run.times.length ? (run.times.length / fps) / 60 : 0;
    return {
        summary: {
            labelled: reals.length, found, latency: median(lats), frameRecall: labelFrames ? hitFrames / labelFrames : null,
            falseTracks, falsePerMin: minutes ? falseTracks / minutes : 0, unknown, tracks: perTrack.length,
            ms: median(run.ms || []), frames: run.times.length, minutes, complete,
        },
        perLabel: [...perLabel.values()],
        perTrack,
    };
}

// A track's sightings for the results file (all of them: a saved run can be scored again
// against newer labels), rounded.
export function compactPts(pts) {
    return pts.map(p => [Math.round(p[0] * 1000) / 1000, Math.round(p[1] * 10) / 10, Math.round(p[2] * 10) / 10, Math.round(p[3] * 10) / 10, Math.round(p[4] * 10) / 10]);
}
