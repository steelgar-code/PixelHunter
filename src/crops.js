// Image crops of objects for the labels (and later a patch network): 32×32 px around the
// object, as a 3-frame stack: red = frame t−s lined up onto t, green = frame t, blue = frame
// t+s lined up onto t (with the camera-motion fit). A still background comes out grey; what
// moves against it shows as colour fringes. Pure: grey images are { cols, rows, data }.

import { inv, project } from './homography.js';

export const CROP = 32;

function sample(img, x, y) {
    const W = img.cols, H = img.rows;
    if (!(x > -0.5 && y > -0.5 && x < W - 0.5 && y < H - 0.5)) return 0;
    const x0 = Math.max(0, Math.min(W - 1, Math.floor(x))), y0 = Math.max(0, Math.min(H - 1, Math.floor(y)));
    const x1 = Math.min(W - 1, x0 + 1), y1 = Math.min(H - 1, y0 + 1);
    const fx = Math.min(1, Math.max(0, x - x0)), fy = Math.min(1, Math.max(0, y - y0));
    const d = img.data;
    const a = d[y0 * W + x0], b = d[y0 * W + x1], c = d[y1 * W + x0], e = d[y1 * W + x1];
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + e * fx) * fy;
}

// RGBA (side × side) centred on (cx, cy) in frame t's pixels. prev / next: grey frames t−s / t+s;
// Hb maps t−s onto t, Hf maps t onto t+s (processing px). Without a fit (Hb / Hf null) that
// channel repeats frame t.
export function stackCrop({ prev = null, cur, next = null, Hb = null, Hf = null }, cx, cy, side = CROP) {
    const out = new Uint8ClampedArray(side * side * 4);
    const Hbi = prev && Hb ? inv(Hb) : null;
    const x0 = Math.round(cx) - (side >> 1), y0 = Math.round(cy) - (side >> 1);
    for (let j = 0; j < side; j++) {
        for (let i = 0; i < side; i++) {
            const x = x0 + i, y = y0 + j, o = (j * side + i) * 4;
            const g = sample(cur, x, y);
            let r = g, b = g;
            if (Hbi) { const [px, py] = project(Hbi, x, y); r = sample(prev, px, py); }
            if (next && Hf) { const [nx, ny] = project(Hf, x, y); b = sample(next, nx, ny); }
            out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = 255;
        }
    }
    return out;
}

// RGBA → PNG Blob (browser).
export async function cropToPng(rgba, side = CROP) {
    const img = new ImageData(rgba, side, side);
    if (typeof OffscreenCanvas !== 'undefined') {
        const c = new OffscreenCanvas(side, side);
        c.getContext('2d').putImageData(img, 0, 0);
        return c.convertToBlob({ type: 'image/png' });
    }
    const c = document.createElement('canvas');
    c.width = c.height = side;
    c.getContext('2d').putImageData(img, 0, 0);
    return new Promise(resolve => c.toBlob(resolve, 'image/png'));
}
