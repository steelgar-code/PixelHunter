// Benchmark scoring (src/benchScore.js): tracks against labels. Node only.
import { ok } from './lib/env.mjs';
import { scoreRun, MIN_INSIDE } from '../src/benchScore.js';

const fps = 25;
const frames = (t0, t1) => Array.from({ length: Math.round((t1 - t0) * fps) + 1 }, (_, i) => +(t0 + i / fps).toFixed(4));
const line = (t0, t1, x0, vx, y = 100, size = 3) => frames(t0, t1).map(t => [t, x0 + (t - t0) * vx, y, size, size]);
const label = (id, lab, keys, extra = {}) => ({ id, label: lab, source: 'tracked', size: [3, 3], contrast: 10, keys, crops: [], created: id, changed: id, ...extra });

const labels = { clip: { id: 'x' }, complete: false, bookmarks: [], objects: [
    label('L1', 'real', [[1, 100, 100, 3, 3], [3, 300, 100, 3, 3]]),          // 100 px/s
    label('L2', 'real', [[1, 100, 300, 3, 3], [3, 100, 300, 3, 3]]),          // still, never found
    label('N1', 'not', [[0, 500, 50, 3, 3], [4, 500, 50, 3, 3]]),
] };
const times = frames(0, 4);
const T1 = { id: 1, pts: line(0.52, 3, 52, 100) };                             // on L1, from before its start
const T2 = { id: 2, pts: line(1, 2, 500, 0, 50) };                             // on the "not" label
const T3 = { id: 3, pts: line(1, 2, 400, 0, 200) };                            // on nothing
const T4 = { id: 4, pts: line(2, 2 + (MIN_INSIDE - 2) / fps, 200, 0) };         // on L1 for 2 frames only
const T5 = { id: 5, pts: [...line(1.5, 1.6, 150, 100), ...line(1.64, 1.74, 150, 100, 150)] };   // half on L1, half 50 px off
const run = { times, tracks: [T1, T2, T3, T4, T5], ms: [10, 20, 30] };

const r = scoreRun(labels, run, { fps });
const v = id => r.perTrack.find(t => t.id === id).verdict;
ok('a track along a real label found it', v(1) === 'real' && r.perLabel.find(l => l.id === 'L1').tracks.includes(1));
ok('… latency from the label\'s start: negative when found earlier, with those sightings offered', Math.abs(r.perLabel.find(l => l.id === 'L1').latency + 0.48) < 1e-9
    && r.perLabel.find(l => l.id === 'L1').earliest.length === 12 && r.perLabel.find(l => l.id === 'L1').earliest.every(p => p[0] < 1));
ok('a track on a "not" label is false', v(2) === 'false' && r.perTrack.find(t => t.id === 2).labelId === 'N1');
ok('a track on no label is unknown while the clip isn\'t complete', v(3) === 'unknown');
ok(`fewer than ${MIN_INSIDE} sightings inside a label's span: no match`, v(4) === 'unknown');
ok('half of the sightings on the path is not enough', v(5) === 'unknown');
const s = r.summary;
ok('summary: found 1 of 2, one false, three unknown, median ms', s.found === 1 && s.labelled === 2 && s.falseTracks === 1 && s.unknown === 3 && s.ms === 20, s);
ok('false tracks per minute over the frames processed', Math.abs(s.falsePerMin - 1 / (times.length / fps / 60)) < 1e-9, s.falsePerMin);
// frame recall: L1 frames 1..3 all hit by T1 (51), L2 frames 1..3 none (51)
ok('frame recall: frames inside real labels with a confirmed sighting on the path', Math.abs(s.frameRecall - 0.5) < 0.02, s.frameRecall);

const rc = scoreRun({ ...labels, complete: true }, run, { fps });
ok('clip marked complete: tracks on no label are false', rc.summary.falseTracks === 4 && rc.summary.unknown === 0, rc.summary);
const none = scoreRun(null, run, { fps });
ok('no labels: everything unknown, nothing labelled', none.summary.labelled === 0 && none.summary.unknown === 5 && none.summary.frameRecall === null);
// a track that follows a label only outside its span isn't matched (and isn't charged as false)
const T6 = { id: 6, pts: line(3.2, 3.8, 320, 100) };
ok('sightings outside a label\'s span don\'t count', scoreRun(labels, { times, tracks: [T6] }, { fps }).perTrack[0].verdict === 'unknown');
// two labels: the one followed best wins
const two = { ...labels, objects: [...labels.objects, label('L3', 'real', [[1, 103, 100, 3, 3], [3, 303, 100, 3, 3]])] };
const r2 = scoreRun(two, { times, tracks: [{ id: 7, pts: line(1, 3, 103, 100) }] }, { fps });
ok('a track matches the label it follows best, only one', r2.perTrack[0].labelId === 'L3' && r2.perLabel.find(l => l.id === 'L1').tracks.length === 0);
