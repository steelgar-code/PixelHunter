// score.js (Node only): matching detections to ground truth.
import { ok } from './lib/env.mjs';
import { matchFrame, createScore } from '../src/score.js';

const T = [{ id: 0, cx: 10, cy: 10 }, { id: 1, cx: 50, cy: 50 }];
let r = matchFrame([{ cx: 11, cy: 10 }, { cx: 80, cy: 80 }], T, 3);
ok('one hit, one false positive, one miss', r.tp === 1 && r.fp === 1 && r.fn === 1 && r.missed[0] === 1, r);
r = matchFrame([{ cx: 10.5, cy: 10 }, { cx: 11, cy: 11 }], T, 3);
ok('a target matches once; the second detection near it is a false positive', r.tp === 1 && r.fp === 1 && r.matches[0].dist === 0.5);
r = matchFrame([{ cx: 30, cy: 30 }], [{ id: 0, cx: 28, cy: 30 }, { id: 1, cx: 31, cy: 30 }], 3);
ok('closest pair wins', r.matches[0].target === 1);
ok('outside the radius is no match', matchFrame([{ cx: 14, cy: 10 }], T, 3).tp === 0);
ok('nothing in, nothing out', JSON.stringify([matchFrame([], [], 3).tp, matchFrame([], [], 3).fp]) === '[0,0]');

const s = createScore({ radius: 3, fps: 25 });
s.add(0, [], [{ id: 0, cx: 5, cy: 5 }]);
s.add(1, [{ cx: 50, cy: 50 }], [{ id: 0, cx: 5, cy: 5 }]);
s.add(2, [{ cx: 5, cy: 6 }], [{ id: 0, cx: 5, cy: 5 }]);
s.add(3, [], []);
const sum = s.summary();
ok('totals', sum.frames === 4 && sum.tp === 1 && sum.fp === 1 && sum.fn === 2, sum);
ok('hit rate', Math.abs(sum.hitRate - 1 / 3) < 1e-9);
ok('false positives per 10 s', Math.abs(sum.fpPer10s - 1 / 4 * 250) < 1e-9);
ok('latency: frames from first appearance to first hit', sum.latency[0] === 2);
s.reset();
ok('reset', s.summary().frames === 0 && s.summary().hitRate === null);
