// Temporal confirmation: blobs are associated into tracks with a constant-velocity model, and a
// track is confirmed once it has been seen in at least N of the last M frames. Pure: no DOM,
// no OpenCV.
//
// Tracks live in the current frame's coordinates ("stabilised" without a growing reference
// frame): each step first carries every track into the new frame with H(t−1→t), position by
// projecting it and velocity by projecting p and p + v. Positions are processing-resolution
// px; velocities px per frame against the background (what the object itself does).
//
// Objects that move in bursts (stop, wait, go on) go undetected while still: motion detection
// sees nothing that doesn't move. A confirmed track missed for more than M frames is "held":
// it waits at its last seen position, with no velocity, for up to holdFrames frames. A blob near
// that position picks it up again with the same id, but it must confirm afresh (N of M and min
// travel) before it is shown, so noise can't revive it.
//
// Blobs marked weak (faint, from the adaptive detector) only continue tracks whose velocity is
// already known (two sightings), within a tight gate around the prediction, and only when not
// much smaller than the track's own blobs; they never start a
// track or pick up a held one. They count as sightings for confirmation, so a faint object that
// stood out once or twice keeps being followed while it barely shows.
//
// Three guards against tracks made of unrelated blobs (each an option, for comparison):
//   - pathCheck: a track only confirms when its recent sightings fit a steady straight path (a
//     least-squares constant-velocity line, RMS deviation ≤ pathTolerance px), and stops being
//     shown when its last sightings stray more than twice that. Noise chained from blob to blob,
//     or a branch swaying back and forth, doesn't stay on such a path. After a gap of PATH_RESTART
//     missed frames the path starts over (the motion may have changed: stop and go);
//   - crowdGate: where blobs are dense, the association radius shrinks so that on average no
//     more than CROWD_EXPECTED unrelated blobs fall inside it (but not below gateBase + 2 px);
//   - motionPause: on a frame without camera motion, tracks can't be carried into the new frame,
//     so their paths are cleared and nothing starts or confirms until motion is back.
//
// Confirmation by evidence (confirmBy: 'evidence', an option to N of M): a track confirms once it
// is at least minAge seconds old and the strength of its sightings adds up to minEvidence (1 = one
// sighting at the detection threshold; a single sighting counts at most EVIDENCE_CAP), on top of
// min travel and the path check. Strong objects confirm about as soon as minAge allows, faint ones
// need longer, and short-lived noise doesn't last long enough. A track still building up is
// dropped after more than maxGap missed frames in a row. Either way, a track's sightings before it
// confirmed are handed out once, with the confirmation (`early`), so the history and the export
// can be back-filled.
//
// Pinned tracks (setPinned: the user's objects of interest) are kept watching: never dropped
// for being gone too long or for frames without camera motion, they wait at their last seen
// position (carried with the scene, also out of view) and pick up movement there again under
// the same id, after confirming afresh.

import { project } from './homography.js';

export const TRACK_DEFAULTS = {
    confirmN: 3,
    confirmM: 5,
    gateBase: 4,           // px: association radius around the prediction …
    gateSpeed: 0.5,        // … plus this × predicted motion (px) …
    gateGrow: 2,           // … plus this × consecutive misses
    maxSpeed: 12,          // px/frame: gate for a track seen once (velocity not known yet)
    alpha: 0.6,            // α-β filter gains
    beta: 0.3,
    minTravel: 3,          // px a track must have moved from where it started before it confirms
    holdFrames: 50,        // frames a confirmed track that is no longer seen is kept (held)
    maxSkip: 5,            // frames without camera motion before all tracks are dropped
    trail: 12,             // positions kept for drawing
    pathCheck: true,
    pathTolerance: 1.5,    // px RMS from a straight steady path, at confirmation
    crowdGate: true,
    motionPause: true,
    confirmBy: 'count',    // 'count' (seen in N of the last M frames) or 'evidence'
    minAge: 0.5,           // s: evidence mode, a track confirms no sooner than this after it started …
    minEvidence: 6,        // … and once its sightings' strength adds up to this
    maxGap: 3,             // evidence mode: missed frames in a row before a track still building up is dropped
};

const CROWD_RADIUS = 40;       // px around a prediction in which blob density is measured
const CROWD_EXPECTED = 0.3;    // unrelated blobs expected inside a gate, at most
const PATH_POINTS = 8;         // sightings kept for the path check
const PATH_RESTART = 4;        // missed frames after which the path check starts over (stop and go)
const WEAK_MIN_AREA = 0.12;    // a weak blob continues a track only at ≥ this × the track's last blob area
const EVIDENCE_CAP = 3;        // evidence: one sighting counts at most this much
const EARLY_KEPT = 300;        // sightings kept per track until it confirms (for back-filling)

const popcount = x => { let n = 0; while (x) { n += x & 1; x >>>= 1; } return n; };

export function createTracker(options = {}) {
    let p = { ...TRACK_DEFAULTS, ...options };
    let tracks = [];
    let pinned = new Set();     // ids kept watching
    let nextId = 1;
    let skipped = 0;
    let clock = 0;             // frames since the start, for the sightings' times
    let now = 0;               // media time of the current step, s
    const evidence = () => p.confirmBy === 'evidence';
    // missed frames after which a confirmed track waits where it was last seen (held)
    const holdAfter = () => (evidence() ? Math.max(p.maxGap, 3) : p.confirmM);
    // a sighting's strength: its score in units of the threshold (adaptive), else 1
    const strength = b => Math.min(EVIDENCE_CAP, b.strength ?? 1);

    function carry(t, H) {
        const [x, y] = project(H, t.x, t.y);
        const [vx, vy] = project(H, t.x + t.vx, t.y + t.vy);
        t.vx = vx - x; t.vy = vy - y; t.x = x; t.y = y;
        [t.sx, t.sy] = project(H, t.sx, t.sy);
        [t.lx, t.ly] = project(H, t.lx, t.ly);
        t.trail = t.trail.map(([a, b]) => project(H, a, b));
        t.pts = t.pts.map(([a, b, c]) => [...project(H, a, b), c]);
        if (t.box) {
            const [bx, by] = project(H, t.box.cx, t.box.cy);
            t.box = { ...t.box, x: t.box.x + bx - t.box.cx, y: t.box.y + by - t.box.cy, cx: bx, cy: by };
        }
    }

    // blobs: [{ cx, cy, x, y, w, h, area }]; H: H(t−1→t) or null when camera motion is unknown;
    // dt: frames since the previous step (1 unless frames were skipped). Returns the tracks.
    // RMS deviation of sightings [x, y, time] from the best constant-velocity line (normalised for
    // the number of sightings)
    function pathDeviation(pts) {
        const n = pts.length;
        if (n < 3) return 0;
        let st = 0, stt = 0;
        for (const q of pts) { st += q[2]; stt += q[2] * q[2]; }
        const mt = st / n, vt = stt / n - mt * mt;
        let err = 0;
        for (const axis of [0, 1]) {
            let sv = 0, stv = 0;
            for (const q of pts) { sv += q[axis]; stv += q[2] * q[axis]; }
            const mv = sv / n, slope = vt > 1e-9 ? (stv / n - mt * mv) / vt : 0;
            for (const q of pts) err += (q[axis] - (mv + slope * (q[2] - mt))) ** 2;
        }
        // a line through n points leaves n − 2 degrees of freedom per axis: scaled so the same
        // tolerance means the same for 3 sightings as for 8
        return Math.sqrt(err / n) / Math.sqrt((n - 2) / n);
    }

    // Blobs per px² within CROWD_RADIUS of (x, y)
    function density(blobs, x, y) {
        let n = 0;
        const r2 = CROWD_RADIUS * CROWD_RADIUS;
        for (const b of blobs) if ((b.cx - x) ** 2 + (b.cy - y) ** 2 <= r2) n++;
        return n / (Math.PI * r2);
    }

    // meta: { time (s), frame } of the frame stepped to (age in evidence mode, back-filling)
    function step(blobs, H, dt = 1, meta = {}) {
        const mask = (1 << p.confirmM) - 1;
        clock += dt;
        now = Number.isFinite(meta.time) ? meta.time : clock / 25;
        const frame = meta.frame ?? null;
        // no camera motion: tracks can't be placed in this frame (motionPause)
        const paused = !H && p.motionPause;
        if (H) {
            skipped = 0;
            for (const t of tracks) carry(t, H);
        } else if (++skipped > p.maxSkip) {
            tracks = tracks.filter(t => pinned.has(t.id));
        }
        if (paused) for (const t of tracks) { t.trail = [[t.x, t.y]]; t.pts = []; }

        // predict, then associate greedily, closest pairs first
        const pairs = [];
        for (const t of tracks) {
            const held = held_(t);
            if (held) { t.vx = 0; t.vy = 0; t.x = t.lx; t.y = t.ly; }
            t.px = t.x + t.vx * dt;
            t.py = t.y + t.vy * dt;
            const motion = t.hits === 1 ? p.maxSpeed * dt : p.gateSpeed * Math.hypot(t.vx, t.vy) * dt;
            // waiting tracks (held, or picked up again and not yet re-confirmed): the search
            // radius stops growing, so a long wait doesn't make it catch every blob around
            const grow = held || t.reacquired ? Math.min(p.gateGrow * t.misses, p.maxSpeed) : p.gateGrow * t.misses;
            let gate = p.gateBase + motion + grow + (H ? 0 : p.gateBase);
            if (p.crowdGate && !held && blobs.length > 1) {
                // dense blobs: shrink the gate so few unrelated ones fall inside it
                const d = density(blobs, t.px, t.py);
                if (d > 0) gate = Math.min(gate, Math.max(p.gateBase + 2, Math.sqrt(CROWD_EXPECTED / (Math.PI * d))));
            }
            // weak blobs: tracks with a known velocity only, gate without the growth for misses
            const weakGate = p.gateBase + motion + Math.min(grow, p.gateBase);
            t.gate = gate; t.weakGate = weakGate;          // for explaining misses (snapshot)
            const weakOk = t.hits >= 2 && !held && H;
            blobs.forEach((b, j) => {
                const d = Math.hypot(b.cx - t.px, b.cy - t.py);
                // (and not much smaller than the track's own blobs: noise is mostly single pixels)
                if (b.weak) { if (weakOk && d <= weakGate && b.area >= WEAK_MIN_AREA * ((t.box && t.box.area) || 1)) pairs.push([d + 0.5, t, j, false]); return; }
                if (d <= gate) { pairs.push([d, t, j, held]); return; }
                // a confirmed track missed a couple of frames may have stopped where it was last
                // seen; a match there restarts its confirmation (see below)
                if (t.confirmed && t.misses >= 2) {
                    const dl = Math.hypot(b.cx - t.lx, b.cy - t.ly);
                    if (dl <= gate) pairs.push([dl, t, j, true]);
                }
            });
        }
        pairs.sort((a, b) => a[0] - b[0]);
        const usedB = new Set(), usedT = new Set();
        for (const [, t, j, restart] of pairs) {
            if (usedT.has(t) || usedB.has(j)) continue;
            usedT.add(t);
            usedB.add(j);
            const b = blobs[j];
            // seen again after a gap: its motion may have changed (stop and go), so the path
            // check starts over from here
            if (t.misses >= PATH_RESTART) t.pts = [];
            if (restart) {
                // picked up again after a pause (or where it stopped): same id, but it confirms
                // afresh from here, so noise around a stopped object can't show as a detection
                t.confirmed = false;
                t.hist = 0;
                t.hits = 0;
                t.sx = b.cx; t.sy = b.cy;
                t.pts = [];
                t.reacquired = (t.reacquired || 0) + 1;
                t.ev = 0; t.t0 = now; t.early = [];
            }
            if (t.hits <= 1) {
                // first or second sighting: the velocity is the displacement (none on the first)
                if (t.hits === 1) { t.vx = (b.cx - t.x) / dt; t.vy = (b.cy - t.y) / dt; } else { t.vx = 0; t.vy = 0; }
                t.x = b.cx; t.y = b.cy;
            } else {
                const ex = b.cx - t.px, ey = b.cy - t.py;
                t.x = t.px + p.alpha * ex; t.y = t.py + p.alpha * ey;
                t.vx += (p.beta / dt) * ex; t.vy += (p.beta / dt) * ey;
            }
            t.hist = ((t.hist << 1) | 1) & mask;
            t.hits++;
            t.misses = 0;
            t.matched = true;
            t.box = { x: b.x, y: b.y, w: b.w, h: b.h, area: b.area, cx: b.cx, cy: b.cy };
            t.lx = b.cx; t.ly = b.cy;
            t.pts.push([b.cx, b.cy, clock]);
            if (t.pts.length > PATH_POINTS) t.pts.shift();
            t.ev += strength(b);
            if (!t.confirmed && t.early.length < EARLY_KEPT) t.early.push(sighting(b, frame, t));
        }
        for (const t of tracks) {
            t.age++;
            if (usedT.has(t)) continue;
            t.x = t.px; t.y = t.py;
            t.hist = (t.hist << 1) & mask;
            t.misses++;
            t.matched = false;
        }
        // drop tracks that can no longer confirm (tentative), and confirmed ones gone longer than
        // M frames and the hold (a re-acquired track keeps its hold until it gives up again)
        const gap = evidence() ? p.maxGap : p.confirmM - p.confirmN;
        tracks = tracks.filter(t => pinned.has(t.id) || (t.confirmed ? t.misses <= Math.max(holdAfter(), p.holdFrames)
            : t.misses <= gap || (t.reacquired && t.misses <= p.holdFrames)));
        for (const t of tracks) {
            if (t.justConfirmed) t.early = [];       // handed out with the last snapshot
            t.justConfirmed = false;
            if (!t.confirmed && !paused && t.matched && enough(t) && Math.hypot(t.x - t.sx, t.y - t.sy) >= p.minTravel
                && (!p.pathCheck || pathDeviation(t.pts) <= p.pathTolerance)) {
                t.confirmed = true;
                t.justConfirmed = true;
            }
            // a confirmed track whose recent path turns out unsteady (sway, chained noise) stops
            // being shown until it is steady again
            else if (t.confirmed && p.pathCheck && t.matched && t.pts.length >= 5 && pathDeviation(t.pts) > 2 * p.pathTolerance && !held_(t)) t.confirmed = false;
            t.trail.push([t.x, t.y]);
            if (t.trail.length > p.trail) t.trail.shift();
        }
        blobs.forEach((b, j) => {
            if (usedB.has(j) || b.weak || paused) return;
            const t = { id: nextId++, x: b.cx, y: b.cy, vx: 0, vy: 0, sx: b.cx, sy: b.cy, lx: b.cx, ly: b.cy, hist: 1, hits: 1, misses: 0, age: 1,
                matched: true, confirmed: false, box: { x: b.x, y: b.y, w: b.w, h: b.h, area: b.area, cx: b.cx, cy: b.cy },
                trail: [[b.cx, b.cy]], pts: [[b.cx, b.cy, clock]], ev: strength(b), t0: now, early: [] };
            t.early.push(sighting(b, frame, t));
            t.confirmed = t.justConfirmed = !evidence() && p.confirmN <= 1 && p.minTravel <= 0;
            tracks.push(t);
        });
        return snapshot();
    }

    // enough sightings to confirm: N of the last M, or (evidence) old enough and strong enough
    function enough(t) {
        if (!evidence()) return popcount(t.hist) >= p.confirmN;
        return t.hits >= 3 && now - t.t0 >= p.minAge - 1e-6 && t.ev >= p.minEvidence;
    }

    // how far a track still building up is towards confirming, 0–1
    function progress(t) {
        if (t.confirmed) return 1;
        if (!evidence()) return Math.min(1, popcount(t.hist) / p.confirmN);
        return Math.min(1, p.minAge > 0 ? (now - t.t0) / p.minAge : 1, p.minEvidence > 0 ? t.ev / p.minEvidence : 1);
    }

    function sighting(b, frame, t) {
        return { frame, time: now, box: { x: b.x, y: b.y, w: b.w, h: b.h, area: b.area, cx: b.cx, cy: b.cy },
            vx: t.vx, vy: t.vy, ...(b.score !== undefined ? { score: b.score } : {}), ...(b.weak ? { weak: true } : {}) };
    }

    // Where the confirmed tracks seen recently should be in the next frame: H = H(t−1→t) carries
    // them into it, then dt frames of their own motion. [{ id, x, y, vx, vy, gate }] in that
    // frame's coordinates, velocity per frame; nothing is changed. For the detector's
    // background-shift check, which must not drop a tracked object (detect.js).
    // onlyPinned: just the tracks the user keeps tracking.
    function predict(H, dt = 1, { onlyPinned = false } = {}) {
        if (!H) return [];
        const out = [];
        for (const t of tracks) {
            if (onlyPinned && !pinned.has(t.id)) continue;
            if (!t.confirmed || t.misses > 1 || held_(t)) continue;
            const [x, y] = project(H, t.x, t.y);
            const [ex, ey] = project(H, t.x + t.vx, t.y + t.vy);
            const vx = ex - x, vy = ey - y;
            out.push({ id: t.id, x: x + vx * dt, y: y + vy * dt, vx, vy, gate: t.gate ?? p.gateBase });
        }
        return out;
    }

    // confirmed, but missed for more than M frames: waiting at its last seen position
    // (a pinned track waits there too while it is re-confirming)
    const held_ = t => (t.confirmed || pinned.has(t.id)) && t.misses > holdAfter();

    function snapshot() {
        return tracks.map(t => ({
            id: t.id, state: held_(t) ? 'held' : t.confirmed ? 'confirmed' : 'tentative', matched: t.matched,
            lastSeen: [t.lx, t.ly], reacquired: t.reacquired || 0, pinned: pinned.has(t.id),
            predicted: [t.px ?? t.x, t.py ?? t.y], gate: t.gate ?? null, weakGate: t.weakGate ?? null, held: held_(t),
            x: t.x, y: t.y, vx: t.vx, vy: t.vy, hits: t.hits, age: t.age, misses: t.misses,
            seen: popcount(t.hist), box: t.box, trail: t.trail.map(q => q.slice()),
            evidence: t.ev, since: t.t0, progress: progress(t),
            // the sightings before it confirmed, once, on the frame it confirms
            ...(t.justConfirmed ? { early: t.early.slice(0, -1) } : {}),
        }));
    }

    return {
        step,
        predict,
        get tracks() { return snapshot(); },
        reset() { tracks = []; skipped = 0; clock = 0; },
        setPinned(ids) { pinned = new Set(ids); },
        setParams(next) { p = { ...p, ...next }; },
        get params() { return p; },
    };
}
