// Confirmed detections, collected per processed frame for the JSON export. Pure.
// Positions are converted back to source-video pixels.

export function createExportLog() {
    let rows = [];
    const ids = new Set();
    return {
        // r: a pipeline result (processing px; r.scale = processing / source)
        add(r) {
            if (!r || !r.confirmed) return;
            const s = r.scale || 1;
            // pixel centres at integers: a point maps as (v + 0.5) / s − 0.5, a box edge as v / s
            const src = v => +((v + 0.5) / s - 0.5).toFixed(2);
            const edge = v => +(v / s).toFixed(2);
            for (const t of r.confirmed) {
                const b = t.box;
                rows.push({
                    frame: r.frame, time: +r.time.toFixed(4), trackId: t.id,
                    box: [edge(b.x), edge(b.y), edge(b.w), edge(b.h)],
                    cx: src(b.cx), cy: src(b.cy), area: +(b.area / (s * s)).toFixed(1),
                    vx: +(t.vx / s).toFixed(3), vy: +(t.vy / s).toFixed(3),
                });
                ids.add(t.id);
            }
        },
        clear() { rows = []; ids.clear(); },
        get count() { return rows.length; },
        get tracks() { return ids.size; },
        toJSON(meta) { return { meta, detections: rows }; },
    };
}

export function download(name, data) {
    const blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
