// Drawing on the overlay canvas, which covers the stage at device resolution so thin lines and
// small boxes stay crisp however the frame is scaled. Frame coordinates (processing
// resolution, pixel centres at integers) are mapped with the same "contain" fit as the
// display canvas.

export function fitOverlay(canvas, frameW, frameH) {
    const dpr = window.devicePixelRatio || 1;
    const cw = Math.round(canvas.clientWidth * dpr), ch = Math.round(canvas.clientHeight * dpr);
    if (canvas.width !== cw || canvas.height !== ch) {
        canvas.width = cw;
        canvas.height = ch;
    }
    const s = Math.min(cw / frameW, ch / frameH);
    const ox = (cw - frameW * s) / 2, oy = (ch - frameH * s) / 2;
    return {
        dpr, s,
        x: x => ox + (x + 0.5) * s,
        y: y => oy + (y + 0.5) * s,
    };
}

export function clear(ctx) {
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
}

const POINT_COLOURS = { 1: '#4cc38a', 0: '#ff5c5c', '-1': '#8b939c' };

// Tracked points of the motion fit from this frame to the next (small-frame px, x y x' y'
// state per point): a dot at each point and a line to where it moves in the next frame.
export function drawPoints(ctx, tf, ego, small) {
    if (!ego || !ego.points) return;
    const P = ego.points;
    const toX = x => tf.x(small.kx * x + (small.kx - 1) / 2);
    const toY = y => tf.y(small.ky * y + (small.ky - 1) / 2);
    const r = Math.max(1.5, 2 * tf.dpr);
    ctx.lineWidth = Math.max(1, tf.dpr);
    for (const state of [-1, 0, 1]) {
        ctx.strokeStyle = ctx.fillStyle = POINT_COLOURS[state];
        ctx.beginPath();
        for (let i = 0; i < P.length; i += 5) {
            if (P[i + 4] !== state) continue;
            ctx.moveTo(toX(P[i]), toY(P[i + 1]));
            ctx.lineTo(toX(P[i + 2]), toY(P[i + 3]));
        }
        ctx.stroke();
        ctx.beginPath();
        for (let i = 0; i < P.length; i += 5) {
            if (P[i + 4] !== state) continue;
            const x = toX(P[i]), y = toY(P[i + 1]);
            ctx.moveTo(x + r, y);
            ctx.arc(x, y, r, 0, Math.PI * 2);
        }
        ctx.fill();
    }
}

// A short line of text in the top-left corner of the frame.
export function drawNote(ctx, tf, text) {
    const pad = 6 * tf.dpr;
    ctx.font = `${12 * tf.dpr}px system-ui, sans-serif`;
    const w = ctx.measureText(text).width;
    const x = tf.x(0) + pad, y = tf.y(0) + pad;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.fillRect(x - pad / 2, y - pad / 2, w + pad, 18 * tf.dpr);
    ctx.fillStyle = '#ffcf5c';
    ctx.textBaseline = 'top';
    ctx.fillText(text, x, y + 1 * tf.dpr);
}

// Boxes around blobs (frame px, x y w h = pixel bounds). Small blobs get a box at least
// `minScreen` px across on screen, centred on them, so a 2 px object is still visible.
export function drawBoxes(ctx, tf, boxes, { colour = '#ffcf5c', minScreen = 12, width = 1.5, alpha = 1 } = {}) {
    const min = minScreen * tf.dpr;
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = colour;
    ctx.lineWidth = width * tf.dpr;
    ctx.beginPath();
    for (const b of boxes) {
        let x0 = tf.x(b.x - 0.5), y0 = tf.y(b.y - 0.5);
        let x1 = tf.x(b.x + b.w - 0.5), y1 = tf.y(b.y + b.h - 0.5);
        if (x1 - x0 < min) { const c = (x0 + x1) / 2; x0 = c - min / 2; x1 = c + min / 2; }
        if (y1 - y0 < min) { const c = (y0 + y1) / 2; y0 = c - min / 2; y1 = c + min / 2; }
        ctx.rect(x0, y0, x1 - x0, y1 - y0);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
}

// Ground-truth targets of a synthetic scene: dashed circles.
export function drawTruth(ctx, tf, targets) {
    ctx.strokeStyle = '#5ce1ff';
    ctx.lineWidth = 1.5 * tf.dpr;
    ctx.setLineDash([3 * tf.dpr, 3 * tf.dpr]);
    for (const t of targets) {
        const r = Math.max(10 * tf.dpr, (t.w / 2 + 4) * tf.s);
        ctx.beginPath();
        ctx.arc(tf.x(t.cx), tf.y(t.cy), r, 0, Math.PI * 2);
        ctx.stroke();
    }
    ctx.setLineDash([]);
}

// Confirmed tracks: a bold box (at least 16 px on screen), the track id and its recent path.
export function drawTracks(ctx, tf, tracks, { colour = '#ff4fd8' } = {}) {
    const min = 16 * tf.dpr;
    ctx.lineWidth = 2 * tf.dpr;
    ctx.strokeStyle = ctx.fillStyle = colour;
    ctx.font = `600 ${11 * tf.dpr}px system-ui, sans-serif`;
    ctx.textBaseline = 'bottom';
    for (const t of tracks) {
        if (t.trail.length > 1) {
            ctx.globalAlpha = 0.6;
            ctx.beginPath();
            t.trail.forEach(([x, y], i) => (i ? ctx.lineTo(tf.x(x), tf.y(y)) : ctx.moveTo(tf.x(x), tf.y(y))));
            ctx.stroke();
            ctx.globalAlpha = 1;
        }
        const b = t.box;
        let x0 = tf.x(b.x - 0.5), y0 = tf.y(b.y - 0.5), x1 = tf.x(b.x + b.w - 0.5), y1 = tf.y(b.y + b.h - 0.5);
        if (x1 - x0 < min) { const c = (x0 + x1) / 2; x0 = c - min / 2; x1 = c + min / 2; }
        if (y1 - y0 < min) { const c = (y0 + y1) / 2; y0 = c - min / 2; y1 = c + min / 2; }
        ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
        ctx.fillText(`#${t.id}`, x0, y0 - 2 * tf.dpr);
    }
}

// Tracks building up (seen a few times, not confirmed yet): a dashed box and a ring that fills
// as the track gets closer to confirming (t.progress, 0–1).
export function drawBuilding(ctx, tf, tracks, { colour = '#ff4fd8' } = {}) {
    const min = 14 * tf.dpr, r = 4 * tf.dpr;
    ctx.save();
    ctx.lineWidth = 1.25 * tf.dpr;
    ctx.strokeStyle = colour;
    for (const t of tracks) {
        const b = t.box;
        let x0 = tf.x(b.x - 0.5), y0 = tf.y(b.y - 0.5), x1 = tf.x(b.x + b.w - 0.5), y1 = tf.y(b.y + b.h - 0.5);
        if (x1 - x0 < min) { const c = (x0 + x1) / 2; x0 = c - min / 2; x1 = c + min / 2; }
        if (y1 - y0 < min) { const c = (y0 + y1) / 2; y0 = c - min / 2; y1 = c + min / 2; }
        ctx.globalAlpha = 0.55;
        ctx.setLineDash([2 * tf.dpr, 3 * tf.dpr]);
        ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
        ctx.setLineDash([]);
        const cx = x1 + r + 2 * tf.dpr, cy = y0 + r;
        ctx.globalAlpha = 0.3;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, 2 * Math.PI);
        ctx.stroke();
        ctx.globalAlpha = 0.9;
        ctx.beginPath();
        ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + 2 * Math.PI * Math.min(1, Math.max(0, t.progress ?? 0)));
        ctx.stroke();
    }
    ctx.restore();
}

// Held tracks (confirmed, not seen for a while): a dashed box at the last seen position.
export function drawHeld(ctx, tf, tracks, { colour = '#ff4fd8' } = {}) {
    const half = 8 * tf.dpr;
    ctx.save();
    ctx.globalAlpha = 0.6;
    ctx.lineWidth = 1.5 * tf.dpr;
    ctx.strokeStyle = ctx.fillStyle = colour;
    ctx.setLineDash([3 * tf.dpr, 3 * tf.dpr]);
    ctx.font = `600 ${11 * tf.dpr}px system-ui, sans-serif`;
    ctx.textBaseline = 'bottom';
    for (const t of tracks) {
        const x = tf.x(t.lastSeen[0]), y = tf.y(t.lastSeen[1]);
        ctx.strokeRect(x - half, y - half, 2 * half, 2 * half);
        ctx.fillText(`#${t.id}`, x - half, y - half - 2 * tf.dpr);
    }
    ctx.restore();
}

// Pinned tracks whose last seen position is outside the w×h frame: an arrow at the edge pointing
// towards it, with the id and how far out it is (frame px).
export function drawOffscreen(ctx, tf, tracks, w, h, colour = '#ff9f43') {
    const inset = 14 * tf.dpr, size = 9 * tf.dpr;
    ctx.save();
    ctx.fillStyle = ctx.strokeStyle = colour;
    ctx.font = `600 ${11 * tf.dpr}px system-ui, sans-serif`;
    for (const t of tracks) {
        const [x, y] = t.lastSeen;
        if (x >= 0 && x <= w - 1 && y >= 0 && y <= h - 1) continue;
        // where the line from the frame centre to it leaves the frame
        const cx = (w - 1) / 2, cy = (h - 1) / 2, dx = x - cx, dy = y - cy;
        const k = Math.min(Math.abs(cx / (dx || 1e-9)), Math.abs(cy / (dy || 1e-9)));
        const ex = cx + dx * k, ey = cy + dy * k;
        const px = Math.min(tf.x(w - 1) - inset, Math.max(tf.x(0) + inset, tf.x(ex)));
        const py = Math.min(tf.y(h - 1) - inset, Math.max(tf.y(0) + inset, tf.y(ey)));
        const a = Math.atan2(dy, dx);
        ctx.beginPath();
        ctx.moveTo(px + Math.cos(a) * size, py + Math.sin(a) * size);
        ctx.lineTo(px + Math.cos(a + 2.5) * size, py + Math.sin(a + 2.5) * size);
        ctx.lineTo(px + Math.cos(a - 2.5) * size, py + Math.sin(a - 2.5) * size);
        ctx.closePath();
        ctx.fill();
        const out = Math.round(Math.hypot(x - ex, y - ey));
        const label = `#${t.id} ${out} px`;
        const tw = ctx.measureText(label).width;
        ctx.textBaseline = 'middle';
        // the label inwards from the arrow, on a dark backing
        const lx = Math.min(tf.x(w - 1) - tw - 4, Math.max(tf.x(0) + 4, px - Math.cos(a) * (tw / 2 + size * 2) - tw / 2));
        const ly = Math.min(tf.y(h - 1) - 8 * tf.dpr, Math.max(tf.y(0) + 8 * tf.dpr, py - Math.sin(a) * size * 2.4));
        ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
        ctx.fillRect(lx - 3 * tf.dpr, ly - 8 * tf.dpr, tw + 6 * tf.dpr, 16 * tf.dpr);
        ctx.fillStyle = colour;
        ctx.fillText(label, lx, ly);
    }
    ctx.restore();
}

// Exclusion zones ({ x, y, w, h } fractions of a w×h frame): a hatched red rectangle with its
// number. `draft` is the one being drawn (dashed outline, no number).
export function drawZones(ctx, tf, zones, w, h, draft = null) {
    const box = z => {
        const x0 = tf.x(z.x * w - 0.5), y0 = tf.y(z.y * h - 0.5);
        return [x0, y0, tf.x((z.x + z.w) * w - 0.5) - x0, tf.y((z.y + z.h) * h - 0.5) - y0];
    };
    ctx.lineWidth = 1.5 * tf.dpr;
    ctx.strokeStyle = '#ff5c5c';
    ctx.font = `600 ${11 * tf.dpr}px system-ui, sans-serif`;
    ctx.textBaseline = 'top';
    zones.forEach((z, i) => {
        const [x, y, bw, bh] = box(z);
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, y, bw, bh);
        ctx.clip();
        ctx.fillStyle = 'rgba(255, 92, 92, 0.12)';
        ctx.fillRect(x, y, bw, bh);
        ctx.strokeStyle = 'rgba(255, 92, 92, 0.35)';
        ctx.lineWidth = tf.dpr;
        ctx.beginPath();
        const step = 8 * tf.dpr;
        for (let d = -bh; d < bw; d += step) { ctx.moveTo(x + d, y + bh); ctx.lineTo(x + d + bh, y); }
        ctx.stroke();
        ctx.restore();
        ctx.strokeRect(x, y, bw, bh);
        ctx.fillStyle = '#ff5c5c';
        ctx.fillText(String(i + 1), x + 3 * tf.dpr, y + 3 * tf.dpr);
    });
    if (draft) {
        const [x, y, bw, bh] = box(draft);
        ctx.setLineDash([4 * tf.dpr, 3 * tf.dpr]);
        ctx.strokeRect(x, y, bw, bh);
        ctx.setLineDash([]);
    }
}

// Inclusion zones: everything outside them dimmed, each outlined in green with its number.
// `draft` is the one being drawn. Call it before anything else is drawn on the overlay.
export function drawInclude(ctx, tf, zones, w, h, draft = null) {
    const box = z => {
        const x0 = tf.x(z.x * w - 0.5), y0 = tf.y(z.y * h - 0.5);
        return [x0, y0, tf.x((z.x + z.w) * w - 0.5) - x0, tf.y((z.y + z.h) * h - 0.5) - y0];
    };
    if (zones.length) {
        // drawn first on the overlay, so clearing the holes takes nothing else with it
        ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
        ctx.fillRect(tf.x(-0.5), tf.y(-0.5), w * tf.s, h * tf.s);
        for (const z of zones) ctx.clearRect(...box(z));
    }
    ctx.lineWidth = 1.5 * tf.dpr;
    ctx.strokeStyle = ctx.fillStyle = '#4cc38a';
    ctx.font = `600 ${11 * tf.dpr}px system-ui, sans-serif`;
    ctx.textBaseline = 'top';
    zones.forEach((z, i) => {
        const [x, y, bw, bh] = box(z);
        ctx.strokeRect(x, y, bw, bh);
        ctx.fillText(`+${i + 1}`, x + 3 * tf.dpr, y + 3 * tf.dpr);
    });
    if (draft) {
        const [x, y, bw, bh] = box(draft);
        ctx.setLineDash([4 * tf.dpr, 3 * tf.dpr]);
        ctx.strokeRect(x, y, bw, bh);
        ctx.setLineDash([]);
    }
}
