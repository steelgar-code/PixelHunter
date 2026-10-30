// Presets saved by the user: settings (detection, confirmation, camera motion), zones
// (inclusion and exclusion), or both, under a name. Kept in localStorage; exported and imported
// as JSON to move them between browsers. Pure apart from the storage passed in.

import { PARAM_DEFS, coerce } from './params.js';
import { normalizeZones } from './zones.js';

export const USER_PRESETS_KEY = 'pixelhunter.presets.v1';
export const MAX_USER_PRESETS = 50;

// the settings a preset carries: the same groups as the built-in ones
export const PRESET_KEYS = PARAM_DEFS.filter(d => ['detect', 'track', 'motion'].includes(d.group) && d.key !== 'zonesMotion').map(d => d.key);

// A preset cleaned up (unknown keys and bad values dropped), or null when unusable.
export function normalizePreset(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const name = String(raw.name || '').trim().slice(0, 60);
    if (!name) return null;
    const out = { name };
    if (raw.values && typeof raw.values === 'object') {
        const values = {};
        for (const k of PRESET_KEYS) {
            const v = coerce(k, raw.values[k]);
            if (v !== undefined) values[k] = v;
        }
        if (Object.keys(values).length) out.values = values;
    }
    if (Array.isArray(raw.zones)) out.zones = normalizeZones(raw.zones);
    if (Array.isArray(raw.include)) out.include = normalizeZones(raw.include);
    return out.values || out.zones || out.include ? out : null;
}

export function normalizePresets(list) {
    const seen = new Set(), out = [];
    for (const p of (Array.isArray(list) ? list : []).map(normalizePreset)) {
        if (!p || seen.has(p.name.toLowerCase())) continue;
        seen.add(p.name.toLowerCase());
        out.push(p);
    }
    return out.slice(0, MAX_USER_PRESETS);
}

// A preset from the current params: settings and / or zones.
export function presetFrom(params, name, { settings = true, zones = true } = {}) {
    const p = { name };
    if (settings) p.values = Object.fromEntries(PRESET_KEYS.map(k => [k, params[k]]));
    if (zones) { p.zones = params.zones || []; p.include = params.include || []; }
    return normalizePreset(p);
}

// The list with `preset` added, replacing one of the same name (case-insensitive).
export function upsert(list, preset) {
    const i = list.findIndex(p => p.name.toLowerCase() === preset.name.toLowerCase());
    const next = list.slice();
    if (i >= 0) next[i] = preset; else next.push(preset);
    return normalizePresets(next);
}

export function remove(list, name) {
    return list.filter(p => p.name.toLowerCase() !== String(name).toLowerCase());
}

export function find(list, name) {
    return list.find(p => p.name.toLowerCase() === String(name).toLowerCase()) || null;
}

// What applying `preset` changes: { values, zones?, include? } (zones only if it has them).
export function changesOf(preset) {
    const out = { values: preset.values || {} };
    if (preset.zones) out.zones = preset.zones;
    if (preset.include) out.include = preset.include;
    return out;
}

// One line saying what a preset holds, for the list.
export function describe(preset) {
    const parts = [];
    if (preset.values) parts.push('settings');
    const nz = (preset.zones || []).length, ni = (preset.include || []).length;
    if (preset.zones || preset.include) parts.push(nz + ni ? `${ni ? `${ni} include` : ''}${ni && nz ? ', ' : ''}${nz ? `${nz} exclude` : ''} zone${nz + ni === 1 ? '' : 's'}` : 'no zones');
    return parts.join(' + ');
}

export function loadPresets(storage) {
    try {
        return normalizePresets(JSON.parse(storage.getItem(USER_PRESETS_KEY) || '[]'));
    } catch {
        return [];
    }
}

export function savePresets(storage, list) {
    try {
        storage.setItem(USER_PRESETS_KEY, JSON.stringify(normalizePresets(list)));
    } catch {
        // private mode or storage full: presets just aren't remembered
    }
}

// Export file contents, and the presets read back from one (merged by name).
export function toFile(list) {
    return { app: 'PixelHunter', kind: 'presets', version: 1, presets: normalizePresets(list) };
}

export function fromFile(data, list) {
    const incoming = normalizePresets(data && (Array.isArray(data) ? data : data.presets));
    let next = list;
    for (const p of incoming) next = upsert(next, p);
    return { list: next, added: incoming.length };
}
