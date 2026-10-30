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
