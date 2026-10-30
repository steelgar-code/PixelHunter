// 3×3 homography math on plain arrays of 9 numbers (row-major). Pure: no DOM, no OpenCV.
//
// Pixel convention (same as OpenCV): integer coordinates are pixel centres, (0, 0) is the
// centre of the top-left pixel.

export const IDENTITY = Object.freeze([1, 0, 0, 0, 1, 0, 0, 0, 1]);

export function mul(A, B) {
    const C = new Array(9);
    for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
            C[i * 3 + j] = A[i * 3] * B[j] + A[i * 3 + 1] * B[3 + j] + A[i * 3 + 2] * B[6 + j];
        }
    }
    return C;
}

// Composes consecutive per-frame fits given newest first: [H(t−1→t), H(t−2→t−1), …,
// H(t−n→t−n+1)] → H(t−n → t) = H(t−1→t) · H(t−2→t−1) · … (column vectors: the earliest step is
// applied first, so it is the rightmost factor).
export function composeNewestFirst(Hs) {
    let H = IDENTITY.slice();
    for (const Hi of Hs) H = mul(H, Hi);
    return H;
}

export function inv(M) {
    const [a, b, c, d, e, f, g, h, i] = M;
    const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
    const det = a * A + b * B + c * C;
    if (!det || !Number.isFinite(det)) return null;
    return [A, -(b * i - c * h), b * f - c * e,
        B, a * i - c * g, -(a * f - c * d),
        C, -(a * h - b * g), a * e - b * d].map(x => x / det);
}

// Scaled so that M[8] = 1 (when possible).
export function normalize(M) {
    const s = M[8];
    return s && Number.isFinite(s) ? M.map(x => x / s) : M.slice();
}

export function project(M, x, y) {
    const w = M[6] * x + M[7] * y + M[8];
    return [(M[0] * x + M[1] * y + M[2]) / w, (M[3] * x + M[4] * y + M[5]) / w];
}

// The four image corners (outer pixel edges) mapped by M, clockwise from top-left.
export function corners(M, w, h) {
    return [[-0.5, -0.5], [w - 0.5, -0.5], [w - 0.5, h - 0.5], [-0.5, h - 0.5]].map(([x, y]) => project(M, x, y));
}

// Maps coordinates of an image downscaled by (kx, ky) to the full image, for resizes that
// align pixel areas (OpenCV INTER_AREA / INTER_LINEAR): x_full = kx·x_small + (kx − 1)/2.
export function scaleMatrix(kx, ky = kx) {
    return [kx, 0, (kx - 1) / 2, 0, ky, (ky - 1) / 2, 0, 0, 1];
}

// A homography estimated on the downscaled image, as one on the full image: A·H·A⁻¹.
// (The requirements' S·H·S⁻¹ with the pixel-centre offset included.)
export function scaleH(H, kx, ky = kx) {
    const A = scaleMatrix(kx, ky);
    return normalize(mul(mul(A, H), inv(A)));
}

// Largest distance between where M and N put the image corners and centre.
export function maxCornerDiff(M, N, w, h) {
    const pts = [[0, 0], [w - 1, 0], [w - 1, h - 1], [0, h - 1], [(w - 1) / 2, (h - 1) / 2]];
    let worst = 0;
    for (const [x, y] of pts) {
        const [ax, ay] = project(M, x, y);
        const [bx, by] = project(N, x, y);
        worst = Math.max(worst, Math.hypot(ax - bx, ay - by));
    }
    return worst;
}

// Rejects homographies that can't be one frame of camera motion: non-finite, flipped or
// folded, too much scale change, or a corner moving more than maxShift × width.
// Returns null when fine, otherwise a short reason.
export function implausible(M, w, h, { minDet = 0.5, maxDet = 2, maxShift = 0.25 } = {}) {
    if (!M || M.length !== 9 || !M.every(Number.isFinite)) return 'no valid fit';
    const H = normalize(M);
    const det = H[0] * H[4] - H[1] * H[3];
    if (!(det >= minDet && det <= maxDet)) return 'implausible scale change';
    const c = corners(H, w, h);
    if (!c.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y))) return 'implausible perspective';
    // the mapped outline must stay convex with the same orientation
    for (let i = 0; i < 4; i++) {
        const [ax, ay] = c[i], [bx, by] = c[(i + 1) % 4], [cx, cy] = c[(i + 2) % 4];
        if ((bx - ax) * (cy - by) - (by - ay) * (cx - bx) <= 0) return 'implausible perspective';
    }
    const orig = corners(IDENTITY, w, h);
    for (let i = 0; i < 4; i++) {
        if (Math.hypot(c[i][0] - orig[i][0], c[i][1] - orig[i][1]) > maxShift * w) return 'motion too large';
    }
    return null;
}
