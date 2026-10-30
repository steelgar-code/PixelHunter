// Zones: rectangles fixed on screen. Exclusion zones (OSD text, a timestamp, a logo, the
// drone's own propellers or landing gear): nothing is detected there. Inclusion zones: only
// there is anything detected, and only those areas are processed. Pure: no DOM, no OpenCV.
//
// A zone is { x, y, w, h } as fractions of the frame (0…1), so it stays put when the
// processing width changes and fits any source of the same aspect. In the URL hash they are
// written as `exclude=x,y,w,h;x,y,w,h` and `include=…` (fractions).

export const ZONES_KEY = 'pixelhunter.zones.v1';
export const INCLUDE_KEY = 'pixelhunter.include.v1';
export const MAX_ZONES = 32;
const MIN_SIZE = 0.002;        // smaller than this (a click without a drag) is dropped

const clamp01 = v => Math.min(1, Math.max(0, v));
const r6 = v => Math.round(v * 1e6) / 1e6;
const EPS = 0.01;              // px: fractions that land within this of a pixel edge snap to it

// A zone clipped to the frame, or null when it is unusable.
export function normalizeZone(z) {
    if (!z) return null;
    let { x, y, w, h } = z;
    if (![x, y, w, h].every(Number.isFinite)) return null;
    if (w < 0) { x += w; w = -w; }
    if (h < 0) { y += h; h = -h; }
    const x0 = clamp01(x), y0 = clamp01(y), x1 = clamp01(x + w), y1 = clamp01(y + h);
    if (x1 - x0 < MIN_SIZE || y1 - y0 < MIN_SIZE) return null;
    return { x: r6(x0), y: r6(y0), w: r6(x1 - x0), h: r6(y1 - y0) };
}

export function normalizeZones(list) {
    return (Array.isArray(list) ? list : []).map(normalizeZone).filter(Boolean).slice(0, MAX_ZONES);
}

// `x,y,w,h;x,y,w,h` ↔ zones. Unparseable entries are skipped.
export function parseZones(text) {
    return normalizeZones(String(text || '').split(/[;\s]+/).filter(Boolean).map(part => {
        const [x, y, w, h] = part.split(',').map(Number);
        return { x, y, w, h };
    }));
}

export function formatZones(zones) {
    return normalizeZones(zones).map(z => [z.x, z.y, z.w, z.h].join(',')).join(';');
}

// Pixel rectangle of a zone in a w×h frame: the pixels x0…x1−1, y0…y1−1 (x1, y1 exclusive).
export function zoneRect(z, w, h) {
    const x0 = Math.max(0, Math.floor(z.x * w + EPS)), y0 = Math.max(0, Math.floor(z.y * h + EPS));
    const x1 = Math.min(w, Math.ceil((z.x + z.w) * w - EPS)), y1 = Math.min(h, Math.ceil((z.y + z.h) * h - EPS));
    return { x0, y0, x1, y1 };
}

// Is the pixel centre (x, y) of a w×h frame inside any zone grown by `pad` px?
export function inZones(zones, x, y, w, h, pad = 0) {
    for (const z of zones) {
        const r = zoneRect(z, w, h);
        if (x >= r.x0 - 0.5 - pad && x <= r.x1 - 0.5 + pad && y >= r.y0 - 0.5 - pad && y <= r.y1 - 0.5 + pad) return true;
    }
    return false;
}

export function loadZones(storage, key = ZONES_KEY) {
    try {
        return normalizeZones(JSON.parse(storage.getItem(key) || '[]'));
    } catch {
        return [];
    }
}

export function saveZones(storage, zones, key = ZONES_KEY) {
    try {
        storage.setItem(key, JSON.stringify(normalizeZones(zones)));
    } catch {
        // private mode or storage full: zones just aren't remembered
    }
}

// Boxes to process for inclusion zones in a w×h frame: each zone's pixel rectangle grown by
// `pad`, clipped to the frame, overlapping or touching boxes merged. null when there are none
// (process the whole frame).
export function regionRects(include, w, h, pad = 0) {
    if (!include || !include.length) return null;
    let rs = include.map(z => zoneRect(z, w, h))
        .filter(r => r.x1 > r.x0 && r.y1 > r.y0)
        .map(r => ({ x0: Math.max(0, r.x0 - pad), y0: Math.max(0, r.y0 - pad), x1: Math.min(w, r.x1 + pad), y1: Math.min(h, r.y1 + pad) }));
    for (let merged = true; merged;) {
        merged = false;
        for (let i = 0; i < rs.length && !merged; i++) {
            for (let j = i + 1; j < rs.length; j++) {
                const a = rs[i], b = rs[j];
                if (a.x0 > b.x1 || b.x0 > a.x1 || a.y0 > b.y1 || b.y0 > a.y1) continue;
                rs[i] = { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
                rs.splice(j, 1);
                merged = true;
                break;
            }
        }
    }
    return rs.length ? rs.map(r => ({ x: r.x0, y: r.y0, w: r.x1 - r.x0, h: r.y1 - r.y0 })) : null;
}
