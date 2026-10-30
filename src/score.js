// Detections against ground truth (synthetic scenes). Pure.
//
// A detection matches a target when its centre is within `radius` px of the target's centre;
// each target and each detection matches at most once (closest pairs first).

export function matchFrame(detections, targets, radius = 3) {
    const pairs = [];
    detections.forEach((d, i) => {
        targets.forEach((t, j) => {
            const dist = Math.hypot(d.cx - t.cx, d.cy - t.cy);
            if (dist <= radius) pairs.push([dist, i, j]);
        });
    });
    pairs.sort((a, b) => a[0] - b[0]);
    const usedD = new Set(), usedT = new Set(), matches = [];
    for (const [dist, i, j] of pairs) {
        if (usedD.has(i) || usedT.has(j)) continue;
        usedD.add(i);
        usedT.add(j);
        matches.push({ detection: i, target: targets[j].id, dist });
    }
    return {
        tp: matches.length,
        fp: detections.length - matches.length,
        fn: targets.length - matches.length,
        matches,
        missed: targets.filter((_, j) => !usedT.has(j)).map(t => t.id),
        falsePositives: detections.filter((_, i) => !usedD.has(i)),
    };
}

// Running totals over a clip. add() takes one frame's detections and truth; summary() gives
// hit rate, false positives per frame and per 10 s, and per target the frames from its first
// appearance to its first detection.
export function createScore({ radius = 3, fps = 25 } = {}) {
    let frames = 0, tp = 0, fp = 0, fn = 0;
    const firstSeen = new Map(), firstHit = new Map();
    return {
        add(frame, detections, targets) {
            const r = matchFrame(detections, targets, radius);
            frames++;
            tp += r.tp; fp += r.fp; fn += r.fn;
            for (const t of targets) if (!firstSeen.has(t.id)) firstSeen.set(t.id, frame);
            for (const mt of r.matches) if (!firstHit.has(mt.target)) firstHit.set(mt.target, frame);
            return r;
        },
        summary() {
            const latency = {};
            for (const [id, f] of firstSeen) latency[id] = firstHit.has(id) ? firstHit.get(id) - f : null;
            return {
                frames, tp, fp, fn,
                hitRate: tp + fn ? tp / (tp + fn) : null,
                fpPerFrame: frames ? fp / frames : 0,
                fpPer10s: frames ? fp / frames * fps * 10 : 0,
                latency,
            };
        },
        reset() { frames = tp = fp = fn = 0; firstSeen.clear(); firstHit.clear(); },
    };
}
