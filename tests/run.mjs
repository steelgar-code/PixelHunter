// Runs the test suites against a local copy of the app.
//   node run.mjs                 all suites
//   node run.mjs playback        only the named suite(s)
import http from 'http';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const args = process.argv.slice(2);
const only = args.filter(a => !a.startsWith('--')).map(a => a.replace(/\.mjs$/, ''));
const suites = fs.readdirSync(here)
    .filter(f => f.endsWith('.mjs') && f !== 'run.mjs')
    .filter(f => !only.length || only.includes(f.replace(/\.mjs$/, '')))
    .sort();

// Minimal static server for the app (repo root), with Range support for video files.
const types = {
    '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json',
    '.css': 'text/css', '.png': 'image/png', '.mp4': 'video/mp4', '.webm': 'video/webm', '.txt': 'text/plain',
};
const server = http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = path.join(root, p === '/' ? 'index.html' : p);
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
    const size = fs.statSync(file).size;
    const headers = { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Accept-Ranges': 'bytes' };
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (m) {
        const start = m[1] ? Number(m[1]) : size - Number(m[2]);
        const end = m[1] && m[2] ? Number(m[2]) : size - 1;
        res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
        fs.createReadStream(file, { start, end }).pipe(res);
        return;
    }
    res.writeHead(200, { ...headers, 'Content-Length': size });
    fs.createReadStream(file).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE_URL = `http://localhost:${server.address().port}/`;

let pass = 0, fail = 0;
const failed = [];
for (const suite of suites) {
    console.log(`\n=== ${suite}`);
    const out = await new Promise(resolve => {
        const child = spawn(process.execPath, [path.join(here, suite), ...args.filter(a => a.startsWith('--'))],
            { env: { ...process.env, BASE_URL }, cwd: here });
        let text = '';
        child.stdout.on('data', d => { text += d; process.stdout.write(d); });
        child.stderr.on('data', d => { text += d; process.stderr.write(d); });
        child.on('close', code => resolve({ text, code }));
    });
    const p = (out.text.match(/^PASS /gm) || []).length, f = (out.text.match(/^FAIL /gm) || []).length;
    pass += p; fail += f;
    if (f || out.code) failed.push(`${suite}${out.code ? ` (exit ${out.code})` : ''}`);
}
server.close();
console.log(`\n${pass} passed, ${fail} failed${failed.length ? ` — ${failed.join(', ')}` : ''}`);
process.exit(fail || failed.length ? 1 : 0);
