// Where the user's data is kept: files in a local data folder the user picks once (File System
// Access API: Chrome / Edge), the real copy; elsewhere, or until a folder is picked, browser
// storage (IndexedDB) with Export / Import. Browser storage also buffers changes the folder
// couldn't take yet (access not allowed again this visit): they are written when it is.
//
// Folder layout:
//   labels/<clip-name>.<id8>.labels.json   a clip's labels (labels.js), bookmarks, "complete"
//   crops/<id8>/<name>.png                 3-frame crops of labelled objects (crops.js)
//   results/<clip-name>.<id8>.<time>.json  benchmark runs (benchView.js)
//
// IndexedDB 'pixelhunter': kv (the folder handle), clips (clip id → { set, exported, pending }),
// crops ('<id8>/<name>' → PNG Blob), results ('<clip id>/<time>' → a run; without a folder,
// the last RESULTS_KEPT per clip).

import { normalizeLabelSet, mergeLabelSets, labelsFileName, id8 } from './labels.js';

const DB_NAME = 'pixelhunter';
const DB_VERSION = 2;
export const RESULTS_KEPT = 20;

function openDb() {
    return new Promise((resolve, reject) => {
        if (typeof indexedDB === 'undefined') { reject(new Error('no browser storage')); return; }
        const rq = indexedDB.open(DB_NAME, DB_VERSION);
        rq.onupgradeneeded = () => {
            const db = rq.result;
            for (const s of ['kv', 'clips', 'crops', 'results']) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
        };
        rq.onsuccess = () => resolve(rq.result);
        rq.onerror = () => reject(rq.error);
    });
}

const req = rq => new Promise((resolve, reject) => { rq.onsuccess = () => resolve(rq.result); rq.onerror = () => reject(rq.error); });

export const folderSupported = () => typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';

export function createDataStore() {
    let dbp = null;
    const db = () => (dbp ??= openDb());
    async function idb(store, mode, fn) {
        const d = await db();
        const tx = d.transaction(store, mode);
        const out = await fn(tx.objectStore(store));
        await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error); });
        return out;
    }
    const get = (store, key) => idb(store, 'readonly', s => req(s.get(key)));
    const put = (store, key, value) => idb(store, 'readwrite', s => req(s.put(value, key)));
    const del = (store, key) => idb(store, 'readwrite', s => req(s.delete(key)));

    let folder = null;            // FileSystemDirectoryHandle
    let access = folderSupported() ? 'none' : 'unsupported';   // none | prompt | granted | denied | unsupported

    async function sub(name, create = true) { return folder.getDirectoryHandle(name, { create }); }

    async function readJson(dir, name) {
        const f = await (await dir.getFileHandle(name)).getFile();
        return JSON.parse(await f.text());
    }

    async function writeFile(dir, name, data) {
        const h = await dir.getFileHandle(name, { create: true });
        const w = await h.createWritable();
        await w.write(data);
        await w.close();
    }

    // The clip's labels file in the folder: { name, set } or null (found by the id in its name).
    async function folderLabels(clip) {
        let dir;
        try { dir = await sub('labels', false); } catch { return null; }
        const tag = `.${id8(clip)}.labels.json`;
        for await (const [name, h] of dir.entries()) {
            if (h.kind !== 'file' || !name.endsWith(tag)) continue;
            try {
                const set = normalizeLabelSet(await readJson(dir, name));
                if (set && set.clip.id === clip.id) return { name, set };
            } catch { /* unreadable: ignored */ }
        }
        return null;
    }

    const usable = () => !!folder && access === 'granted';

    return {
        get folderName() { return folder ? folder.name : null; },
        // 'unsupported' (no folder access in this browser), 'none' (none picked), 'prompt'
        // (picked, needs a click to allow again this visit), 'granted', 'denied'
        get access() { return access; },
        get usable() { return usable(); },

        async init() {
            if (access === 'unsupported') return access;
            try {
                folder = (await get('kv', 'folder')) || null;
                if (folder) access = await folder.queryPermission({ mode: 'readwrite' });
            } catch { folder = null; access = 'none'; }
            return access;
        },
        // the browser's folder picker (needs a click)
        async pickFolder() {
            const h = await window.showDirectoryPicker({ id: 'pixelhunter-data', mode: 'readwrite' });
            folder = h;
            access = await h.queryPermission({ mode: 'readwrite' });
            if (access !== 'granted') access = await h.requestPermission({ mode: 'readwrite' });
            // remembered for the next visits; not the browser's own private storage (no name: tests
            // stand it in for a folder, and headless Chromium closes a page that reads it back)
            if (h.name) try { await put('kv', 'folder', h); } catch { /* remembered for this visit only */ }
            return access;
        },
        // access to the remembered folder again (needs a click)
        async allow() {
            if (!folder) return access;
            access = await folder.requestPermission({ mode: 'readwrite' });
            return access;
        },
        async forgetFolder() {
            folder = null;
            access = folderSupported() ? 'none' : 'unsupported';
            try { await del('kv', 'folder'); } catch { /* nothing kept */ }
        },

        // A clip's labels: from the folder and from browser storage, merged.
        // → { set (or null), inFolder, inBrowser, pending (browser copy not in the folder yet), exported }
        async loadClip(clip) {
            let f = null, b = null;
            if (usable()) { try { f = await folderLabels(clip); } catch { f = null; } }
            try { b = await get('clips', clip.id); } catch { b = null; }
            const bset = b ? normalizeLabelSet(b.set) : null;
            const set = mergeLabelSets(f ? f.set : null, bset);
            return { set, inFolder: !!f, inBrowser: !!bset, pending: !!(b && b.pending), exported: b ? b.exported || null : null };
        },

        // Saves a clip's labels and new crops ({ name → Blob }). Always to browser storage first;
        // then, with folder access, to the folder (and the browser copy is dropped).
        // → 'folder' or 'browser'.
        async saveClip(set, crops = {}) {
            let prev = null;
            try { prev = await get('clips', set.clip.id); } catch { /* none */ }
            const exported = prev ? prev.exported || null : null;
            await put('clips', set.clip.id, { set, exported, pending: true, saved: new Date().toISOString() });
            for (const [name, blob] of Object.entries(crops)) await put('crops', `${id8(set.clip)}/${name}`, blob);
            if (!usable()) return 'browser';
            const dir = await sub('labels');
            const fname = labelsFileName(set.clip);
            await writeFile(dir, fname, JSON.stringify(set, null, 1));
            // the same clip under an older name: removed
            const tag = `.${id8(set.clip)}.labels.json`;
            for await (const [name, h] of dir.entries()) if (h.kind === 'file' && name !== fname && name.endsWith(tag)) await dir.removeEntry(name).catch(() => {});
            // crops: the new ones, and any still waiting in browser storage
            const cdir = await (await sub('crops')).getDirectoryHandle(id8(set.clip), { create: true });
            const waiting = await idb('crops', 'readonly', s => req(s.getAllKeys(IDBKeyRange.bound(`${id8(set.clip)}/`, `${id8(set.clip)}/￿`))));
            for (const key of waiting) {
                const blob = crops[key.slice(9)] || await get('crops', key);
                if (blob) await writeFile(cdir, `${key.slice(9)}.png`, blob);
                await del('crops', key);
            }
            await del('clips', set.clip.id);
            return 'folder';
        },

        // A benchmark run (benchView.js): to the folder's results/, else browser storage (the
        // last RESULTS_KEPT per clip). → 'folder' or 'browser'.
        async saveResult(clip, result) {
            const stamp = String(result.created).replace(/[:.]/g, '-');
            if (usable()) {
                const base = labelsFileName(clip).replace(/\.labels\.json$/, '');
                await writeFile(await sub('results'), `${base}.${stamp}.json`, JSON.stringify(result));
                return 'folder';
            }
            await put('results', `${clip.id}/${stamp}`, result);
            const keys = await idb('results', 'readonly', s => req(s.getAllKeys(IDBKeyRange.bound(`${clip.id}/`, `${clip.id}/\uffff`))));
            for (const k of keys.slice(0, Math.max(0, keys.length - RESULTS_KEPT))) await del('results', k);
            return 'browser';
        },
        // The clip's latest saved run, or null.
        async latestResult(clip) {
            const tag = `.${id8(clip)}.`;
            if (usable()) {
                try {
                    const dir = await sub('results', false);
                    let best = null;
                    for await (const [name, h] of dir.entries()) if (h.kind === 'file' && name.includes(tag) && (!best || name.slice(name.indexOf(tag)) > best.slice(best.indexOf(tag)))) best = name;
                    if (best) { const r = await readJson(dir, best); if (r && r.clip && r.clip.id === clip.id) return r; }
                } catch { /* none */ }
            }
            try {
                const keys = await idb('results', 'readonly', s => req(s.getAllKeys(IDBKeyRange.bound(`${clip.id}/`, `${clip.id}/\uffff`))));
                return keys.length ? await get('results', keys[keys.length - 1]) : null;
            } catch { return null; }
        },

        // A crop's PNG (folder or browser storage), or null.
        async loadCrop(clip, name) {
            if (usable()) {
                try { return await (await (await (await sub('crops', false)).getDirectoryHandle(id8(clip))).getFileHandle(`${name}.png`)).getFile(); } catch { /* not there */ }
            }
            try { return (await get('crops', `${id8(clip)}/${name}`)) || null; } catch { return null; }
        },

        // Exported now (browser storage only: "not backed up" counts from here).
        async markExported(clipId, when = new Date().toISOString()) {
            try {
                const b = await get('clips', clipId);
                if (b) await put('clips', clipId, { ...b, exported: when });
            } catch { /* not kept */ }
        },

        // Clips kept in browser storage: [{ id, name, objects, pending }]
        async browserClips() {
            try {
                const all = await idb('clips', 'readonly', s => req(s.getAll()));
                return all.map(b => ({ id: b.set.clip.id, name: b.set.clip.name, objects: b.set.objects.length, pending: !!b.pending }));
            } catch { return []; }
        },

        async estimate() {
            try { return navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null; } catch { return null; }
        },
        async persist() {
            try { return navigator.storage && navigator.storage.persist ? await navigator.storage.persist() : false; } catch { return false; }
        },
    };
}
