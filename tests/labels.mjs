// Labels model (src/labels.js) and 3-frame crops (src/crops.js): keyframes, interpolation,
// merging, the labels file, clip ids, finding a label near a position. Node only.
import { ok } from './lib/env.mjs';
import { interpolate, simplify, mergeKeys, keysFromHistory, newLabelSet, upsertObject, removeObject, removeKeyAt, labelAt,
    normalizeLabelSet, mergeLabelSets, fileClipId, urlClipId, labelsFileName, matchRadius, extendRadius, counts, changedSince,
    normalizeBookmarks } from '../src/labels.js';
import { stackCrop, CROP } from '../src/crops.js';

const clip = { id: 'ab'.repeat(32), name: 'flight 3.mp4', bytes: 1000, duration: 10, width: 640, height: 360, fps: 25 };

// --- paths ---
const line = Array.from({ length: 100 }, (_, i) => [i / 25, 10 + i * 0.8, 50 - i * 0.3, 3, 3]);
const k1 = simplify(line);
ok('a straight, steady path keeps only its two ends', k1.length === 2 && k1[0][0] === 0 && k1[1][0] === line[99][0], k1.length);
const jitter = line.map((k, i) => [k[0], k[1] + (i % 2 ? 0.4 : -0.4), k[2], k[3] + (i % 3 === 0 ? 1 : 0), k[4]]);
ok('jitter of ±0.4 px (and size ±1 px) is dropped', simplify(jitter).length <= 4, simplify(jitter).length);
const turn = [...line.slice(0, 50), ...line.slice(50).map((k, i) => [k[0], line[49][1], line[49][2] + (i + 1) * 0.8, 3, 3])];
const kt = simplify(turn);
ok('a turn is kept (and the path within 1 px everywhere)', kt.length >= 3 && turn.every(k => { const p = interpolate(kt, k[0]); return Math.hypot(p[0] - k[1], p[1] - k[2]) <= 1 + 1e-9; }), kt.length);
const p = interpolate([[1, 0, 0, 2, 2], [3, 10, 20, 4, 4]], 2);
ok('interpolated linearly between keyframes', p[0] === 5 && p[1] === 10 && p[2] === 3, p);
ok('outside the span: none; within the slack: the end', interpolate([[1, 0, 0, 2, 2], [3, 10, 20, 4, 4]], 3.5) === null
    && interpolate([[1, 0, 0, 2, 2], [3, 10, 20, 4, 4]], 3.2, 0.25)[0] === 10);
const m = mergeKeys([[0, 1, 1, 2, 2], [1, 2, 2, 2, 2]], [[1.0002, 9, 9, 2, 2], [2, 3, 3, 2, 2]]);
ok('merged in time order; at the same time the newer point wins', m.length === 3 && m[1][1] === 9 && m[2][0] === 2, m);
const hist = [{ frame: 1, time: 0.04, seen: true, x: 10, y: 10, w: 2, h: 2 }, { frame: 2, time: 0.08, seen: false, x: 11, y: 10 },
    { frame: 2, time: 0.08, event: 'lost' }, { frame: 3, time: 0.12, seen: true, early: true, x: 12, y: 10, w: 2, h: 2 }];
ok('history → points where it was seen (early sightings too), not misses or events', JSON.stringify(keysFromHistory(hist)) === JSON.stringify([[0.04, 10, 10, 2, 2], [0.12, 12, 10, 2, 2]]), keysFromHistory(hist));

// --- a clip's labels ---
const set = newLabelSet(clip);
upsertObject(set, { id: 'a1', label: 'real', size: [3, 3], contrast: -12.34, keys: line });
const a1 = set.objects[0];
ok('a label from a tracked path: keyframes, size, contrast, times', a1.keys.length === 2 && a1.contrast === -12.3 && a1.created && a1.changed && a1.source === 'tracked');
upsertObject(set, { id: 'a1', label: 'not', keys: [[5, 200, 200, 3, 3]] });
ok('updating: label changes, new points merged into the path', a1.label === 'not' && a1.keys.length === 3 && a1.keys[2][0] === 5);
upsertObject(set, { id: 'm1', label: 'real', source: 'marked', size: [4, 4], keys: [[1, 300, 100, 4, 4]] });
upsertObject(set, { id: 'm1', keys: [[2, 310, 100, 4, 4]] });
ok('a marked object: points added one by one', set.objects[1].keys.length === 2 && set.objects[1].source === 'marked');
ok('counts', JSON.stringify(counts(set)) === JSON.stringify({ real: 1, not: 1, marked: 1 }), counts(set));
removeKeyAt(set, 'm1', 2);
ok('undo removes the point nearest in time', set.objects[1].keys.length === 1 && set.objects[1].keys[0][0] === 1);
removeKeyAt(set, 'm1', 1);
ok('… and the object with its last point', set.objects.length === 1);
upsertObject(set, { id: 'r2', label: 'real', size: [2, 2], keys: [[0, 100, 100, 2, 2], [4, 140, 100, 2, 2]] });
ok('labelAt: on the path within max(4 px, 1.5 × size)', labelAt(set, 2, 120, 103.5)?.id === 'r2' && labelAt(set, 2, 120, 104.5) === null);
ok('labelAt: not beyond the span, unless within the slack', labelAt(set, 4.5, 140, 100) === null && labelAt(set, 4.2, 140, 100, { slack: 0.25 })?.id === 'r2');
ok('labelAt: skips labels already taken', labelAt(set, 2, 120, 100, { except: new Set(['r2']) }) === null);
ok('match and extend radii', matchRadius([2, 2]) === 4 && matchRadius([6, 4]) === 9 && extendRadius([2, 2]) === 6 && extendRadius([5, 5]) === 10);
const before = set.objects.find(o => o.id === 'r2').changed;
ok('changedSince counts objects changed after an export', changedSince(set, null) === 2 && changedSince(set, before) === 0 && changedSince(set, '2000-01-01') === 2);
removeObject(set, 'a1');
ok('removing a label', set.objects.length === 1 && set.objects[0].id === 'r2');

// --- the file ---
const back = normalizeLabelSet(JSON.parse(JSON.stringify(set)));
ok('a labels file reads back the same', JSON.stringify(back.objects) === JSON.stringify(set.objects) && back.clip.id === clip.id);
ok('not a labels file: rejected', normalizeLabelSet({ kind: 'presets' }) === null && normalizeLabelSet({ kind: 'labels', clip: { id: 'x' } }) === null
    && normalizeLabelSet({ ...set, version: 99 }) === null);
const messy = normalizeLabelSet({ ...set, objects: [{ id: 'q', label: 'maybe', keys: [[0, 1, 1, 1, 1]] }, { id: 'z', label: 'real', keys: [[0, 'x'], [1, 5, 5, 2, 2]] }, { id: 'e', label: 'not', keys: [] }],
    bookmarks: [{ frame: 5, time: 0.2 }, { frame: 5, time: 0.2 }, { frame: 'x' }] });
ok('bad objects and points dropped, bookmarks cleaned', messy.objects.length === 1 && messy.objects[0].keys.length === 1 && messy.bookmarks.length === 1, messy.objects);
ok('file name: clip name and id', labelsFileName(clip) === `flight_3.${'abababab'}.labels.json`, labelsFileName(clip));

// --- merging two versions ---
const A = normalizeLabelSet(JSON.parse(JSON.stringify(set)));
const B = normalizeLabelSet(JSON.parse(JSON.stringify(set)));
B.objects[0].label = 'not'; B.objects[0].changed = '2100-01-01T00:00:00.000Z';
B.objects.push({ ...B.objects[0], id: 'new', created: '2100-01-02T00:00:00.000Z' });
A.bookmarks = [{ frame: 1, time: 0.04 }]; B.bookmarks = [{ frame: 2, time: 0.08 }];
B.complete = true; B.changed = '2100-01-01T00:00:00.000Z';
const M = mergeLabelSets(A, B);
ok('merge: per object the later change wins, new ones added', M.objects.length === 2 && M.objects[0].label === 'not' && M.objects[1].id === 'new');
ok('merge: bookmarks together, "complete" from the newer set', M.bookmarks.length === 2 && M.complete === true);
ok('merge the other way round: same objects', mergeLabelSets(B, A).objects.find(o => o.id === 'r2').label === 'not');
ok('bookmarks: one per frame, in order', JSON.stringify(normalizeBookmarks([{ frame: 9, time: 1 }, { frame: 2, time: 0.1 }, { frame: 9, time: 1 }]).map(b => b.frame)) === '[2,9]');

// --- clip ids ---
const bytes = new Uint8Array(3 << 20).map((_, i) => (i * 7919) & 255);
const id1 = await fileClipId(new Blob([bytes]));
const id2 = await fileClipId(new File([bytes], 'renamed.mp4'));
const middle = bytes.slice(); middle[(3 << 20) >> 1] ^= 1;
const id3 = await fileClipId(new Blob([middle]));
const id4 = await fileClipId(new Blob([bytes.slice(0, bytes.length - 1)]));
ok('clip id: the same content under another name is the same clip', id1 === id2 && /^[0-9a-f]{64}$/.test(id1));
ok('clip id: from the first and last 1 MB and the size (a change in the middle is not seen; the size is)', id1 === id3 && id1 !== id4);
ok('URL clip id: by address, duration and size', (await urlClipId('https://x/a.mp4', 10, 640, 360)) !== (await urlClipId('https://x/a.mp4', 10, 1280, 720)));

// --- 3-frame crops ---
const W = 64, H = 48;
const img = f => { const data = new Uint8Array(W * H); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) data[y * W + x] = f(x, y); return { cols: W, rows: H, data }; };
const bg = (x, y) => (x * 3 + y * 2) & 255;
const dot = (f, ox) => (x, y) => (Math.abs(x - (32 + ox)) <= 1 && Math.abs(y - 24) <= 1 ? 250 : f(x, y));
// the camera moved 3 px between frames: prev(x) = scene(x + 3), next(x) = scene(x − 3); the dot moves +2 px per frame on the scene
const cur = img(dot(bg, 0));
const prev = img((x, y) => dot(bg, -2)(x + 3, y));
const next = img((x, y) => dot(bg, 2)(x - 3, y));
const Hb = [1, 0, 3, 0, 1, 0, 0, 0, 1];   // prev → cur
const Hf = [1, 0, 3, 0, 1, 0, 0, 0, 1];   // cur → next
const c = stackCrop({ prev, cur, next, Hb, Hf }, 32, 24);
const px = (x, y) => { const i = ((y - 24 + 16) * CROP + (x - 32 + 16)) * 4; return [c[i], c[i + 1], c[i + 2]]; };
ok('crop: 32×32 RGBA', c.length === CROP * CROP * 4);
ok('crop: still background lined up (red = green = blue)', [[25, 20], [40, 30], [20, 10]].every(([x, y]) => { const [r, g, b] = px(x, y); return r === g && g === b; }), px(25, 20));
ok('crop: the mover where it was in red, where it is in green, where it goes in blue', px(30, 24)[0] === 250 && px(30, 24)[1] !== 250 && px(32, 24)[1] === 250 && px(34, 24)[2] === 250 && px(34, 24)[1] !== 250, [px(30, 24), px(32, 24), px(34, 24)]);
const c2 = stackCrop({ cur }, 32, 24);
ok('crop without camera motion: all three channels frame t', c2[0] === c2[1] && c2[1] === c2[2]);
const c3 = stackCrop({ cur }, 2, 2);
ok('crop at the edge: outside the frame is black', c3[0] === 0 && c3[(31 * CROP + 31) * 4 + 1] !== 0);
