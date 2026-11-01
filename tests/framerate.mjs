// frameLoop.js estimateFrameDuration (Node only): the frame duration from mediaTime differences,
// as real-time mode sees them (skipped frames), with jittery and stray timestamps.
import { ok } from './lib/env.mjs';
import { estimateFrameDuration as est } from '../src/frameLoop.js';
import { mulberry32 } from '../src/synth.js';

const near = (v, want, tol = 0.0005) => v !== null && Math.abs(v - want) < tol;
const r = mulberry32(5);
// real-time at 25 fps, processing about every 2nd–3rd frame
const skips = n => Array.from({ length: n }, () => 0.04 * (1 + Math.floor(r() * 3)));

ok('every frame at 25 fps: 40 ms', near(est(Array(30).fill(0.04)), 0.04));
ok('real-time, 1–3 frames apart: 40 ms', near(est(skips(60)), 0.04), est(skips(60)));
ok('29.97 fps: 33.37 ms', near(est(Array.from({ length: 40 }, (_, i) => 1.001 / 30 * (1 + (i % 3)))), 1.001 / 30));
{
    // the case seen on a real 640×512 H.264 file: one stray, nearly identical timestamp pair made
    // the estimate 1.5 ms, so every frame looked like ~50 skipped
    const s = skips(59);
    s.splice(20, 0, 0.0015);
    ok('a stray 1.5 ms difference among them: still 40 ms', near(est(s), 0.04), est(s));
    const h = skips(58);
    h.splice(10, 0, 0.02, 0.02);
    ok('a couple of half-frame differences: still 40 ms', near(est(h), 0.04), est(h));
}
{
    // timestamps jittering by ±4 ms (time-base rounding, variable-rate recording)
    const s = skips(60).map(x => x + (r() - 0.5) * 0.008);
    ok('jitter of ±4 ms: within 1 ms of 40 ms', near(est(s), 0.04, 0.001), est(s));
}
{
    // only even skips (80 / 160 ms) can't be told from 12.5 fps — unless the start-up probe says 40
    const s = Array.from({ length: 40 }, (_, i) => (i % 2 ? 0.08 : 0.16));
    ok('only 2- and 4-frame steps, no probe: 80 ms (indistinguishable)', near(est(s), 0.08));
    ok('… with the probe: 40 ms', near(est(s, 0.04), 0.04));
    ok('a probe that fits nothing is ignored', near(est(Array(30).fill(0.04), 0.0333), 0.04));
}
ok('no usable samples: the probe, else null', est([0.001], 0.04) === 0.04 && est([0.001]) === null && est([]) === null);
