// MediaMTX for the stream tests: the binary from $MEDIAMTX, the PATH, or tests/.cache/mediamtx
// (built there from source with Go when missing: GitHub release downloads may be blocked; the
// Go module proxy usually isn't). Started with gateway/mediamtx.yml; ffmpeg publishes clips to it.
import fs from 'fs';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import { CACHE } from './clips.mjs';

const VERSION = 'v1.21.3';
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');

function which(cmd) {
    const r = spawnSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' });
    return r.status === 0 ? r.stdout.trim() : null;
}

// The binary's path, or null (with the reason in `why`).
export function findMediamtx() {
    if (process.env.MEDIAMTX && fs.existsSync(process.env.MEDIAMTX)) return { bin: process.env.MEDIAMTX };
    const inPath = which('mediamtx');
    if (inPath) return { bin: inPath };
    const cached = path.join(CACHE, 'mediamtx');
    if (fs.existsSync(cached)) return { bin: cached };
    if (!which('go')) return { bin: null, why: 'no mediamtx binary (set MEDIAMTX) and no Go to build one' };
    // build: the module from the Go proxy, plus the two files its source tree generates
    fs.mkdirSync(CACHE, { recursive: true });
    const gopath = path.join(CACHE, 'gopath');
    const env = { ...process.env, GOPATH: gopath, GOFLAGS: '-modcacherw', GOTOOLCHAIN: 'auto' };
    const dl = spawnSync('go', ['mod', 'download', '-json', `github.com/bluenviron/mediamtx@${VERSION}`], { env, encoding: 'utf8', cwd: CACHE });
    if (dl.status !== 0) return { bin: null, why: `go mod download failed: ${dl.stderr.slice(0, 300)}` };
    const dir = JSON.parse(dl.stdout).Dir;
    const src = path.join(CACHE, 'mediamtx-src');
    fs.rmSync(src, { recursive: true, force: true });
    fs.cpSync(dir, src, { recursive: true });
    spawnSync('chmod', ['-R', 'u+w', src]);
    // its own web player (unused here) embeds hls.js; any copy will do
    fs.copyFileSync(path.join(root, 'vendor', 'hls-1.7.3.light.min.js'), path.join(src, 'internal', 'servers', 'hls', 'hls.min.js'));
    fs.writeFileSync(path.join(src, 'internal', 'core', 'VERSION'), VERSION);
    const b = spawnSync('go', ['build', '-o', cached, '.'], { env, cwd: src, encoding: 'utf8' });
    // the sources (~1 GB with dependencies) aren't needed once it is built
    spawnSync('chmod', ['-R', 'u+w', gopath]);
    fs.rmSync(gopath, { recursive: true, force: true });
    fs.rmSync(src, { recursive: true, force: true });
    if (b.status !== 0) return { bin: null, why: `go build failed: ${b.stderr.slice(0, 300)}` };
    return { bin: cached };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Starts MediaMTX with gateway/mediamtx.yml; resolves once it listens. { stop() }
export async function startMediamtx(bin) {
    const p = spawn(bin, [path.join(root, 'gateway', 'mediamtx.yml')], { cwd: CACHE, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    p.stdout.on('data', d => { log += d; });
    p.stderr.on('data', d => { log += d; });
    for (let i = 0; i < 50 && !/\[WebRTC\] started/.test(log); i++) await sleep(100);
    if (!/\[WebRTC\] started/.test(log)) { p.kill(); throw new Error(`MediaMTX did not start: ${log.slice(-500)}`); }
    return { get log() { return log; }, stop() { p.kill('SIGINT'); } };
}

// Publishes a clip in a loop to rtsp://127.0.0.1:8554/<name>, as H.264 Constrained Baseline
// (what every browser's WebRTC decodes; Playwright's Chromium offers no High profile there),
// a keyframe every second. { stop() }
export async function publish(clip, name) {
    const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-re', '-stream_loop', '-1', '-i', clip, '-an',
        '-c:v', 'libx264', '-profile:v', 'baseline', '-preset', 'ultrafast', '-tune', 'zerolatency', '-crf', '18', '-g', '25', '-pix_fmt', 'yuv420p',
        '-f', 'rtsp', '-rtsp_transport', 'tcp', `rtsp://127.0.0.1:8554/${name}`], { stdio: 'ignore' });
    await sleep(2500);
    return { stop() { p.kill('SIGINT'); } };
}
