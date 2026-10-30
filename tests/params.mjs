// params.js: defaults, coercion, hash and storage handling (Node only).
import { ok } from './lib/env.mjs';
import { PARAM_DEFS, defaults, coerce, resolveParams, parseHash, toSaved, loadSaved, save, STORAGE_KEY } from '../src/params.js';

const d = defaults();
ok('defaults cover every definition', PARAM_DEFS.every(p => d[p.key] === p.default));
ok('choice coercion keeps known values only', coerce('mode', 'everyFrame') === 'everyFrame' && coerce('mode', 'bogus') === undefined);
ok('numbers are clamped to the range', coerce('simLoad', '9999') === 500 && coerce('simLoad', '-3') === 0 && coerce('simLoad', 'x') === undefined);
ok('unknown keys are ignored', coerce('nope', 1) === undefined);
ok('hash parsing', JSON.stringify(parseHash('#mode=everyFrame&simLoad=60&x')) === JSON.stringify({ mode: 'everyFrame', simLoad: '60', x: '' }));
const p = resolveParams({ mode: 'everyFrame', simLoad: 20 }, { simLoad: '60' });
ok('hash wins over saved values', p.mode === 'everyFrame' && p.simLoad === 60);
ok('non-persisted and default values are not saved', JSON.stringify(toSaved({ ...d, simLoad: 50 })) === '{}' && toSaved({ ...d, mode: 'everyFrame' }).mode === 'everyFrame');

const mem = new Map();
const storage = { getItem: k => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
save(storage, { ...d, mode: 'everyFrame' });
ok('save / load round trip', loadSaved(storage).mode === 'everyFrame');
mem.set(STORAGE_KEY, '{broken');
ok('broken storage falls back to defaults', JSON.stringify(loadSaved(storage)) === '{}');
const throwing = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
save(throwing, d);
ok('storage errors are swallowed', JSON.stringify(loadSaved(throwing)) === '{}');
