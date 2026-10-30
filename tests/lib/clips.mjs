// Test clips made with ffmpeg and cached in tests/.cache/.
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

export const CACHE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.cache');

function ffmpeg(args, out) {
    fs.mkdirSync(CACHE, { recursive: true });
    const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args, out], { encoding: 'utf8' });
    if (r.error) throw new Error(`ffmpeg is needed for the test clips: ${r.error.message}`);
    if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`);
    return out;
}

// 320×240 H.264 clip whose top half carries the frame number as 8 binary blocks, 40 px wide
// each (bit i = block i, white = 1). Read back with readFrameNumber().
export function frameNumberClip({ fps = 25, seconds = 4, gop = 50 } = {}) {
    const out = path.join(CACHE, `framenum-${fps}fps-${seconds}s-g${gop}.mp4`);
    if (fs.existsSync(out)) return out;
    const geq = "lum='if(lt(Y,120),if(eq(mod(floor(N/pow(2,floor(X/40))),2),1),235,16),128)'";
    return ffmpeg(['-f', 'lavfi', '-i', `color=c=gray:s=320x240:r=${fps}:d=${seconds},format=gray,geq=${geq},format=yuv420p`,
        '-c:v', 'libx264', '-crf', '18', '-g', String(gop), '-pix_fmt', 'yuv420p', '-movflags', '+faststart'], out);
}

// Runs in the page: reads the frame number drawn on the display canvas.
export const readFrameNumber = () => {
    const c = document.getElementById('display');
    const ctx = c.getContext('2d');
    let n = 0;
    for (let i = 0; i < 8; i++) {
        const x = Math.round((20 + 40 * i) * c.width / 320), y = Math.round(60 * c.height / 240);
        if (ctx.getImageData(x, y, 1, 1).data[0] > 128) n |= 1 << i;
    }
    return n;
};

// A synthetic scene (src/synth.js options) encoded with tools/make-clip.mjs, cached by its
// options. Resolves with { path, truth }.
export async function sceneClip(options, { crf = 18, codec = 'libx264' } = {}) {
    const { createHash } = await import('crypto');
    const { makeClip } = await import('../../tools/make-clip.mjs');
    const key = createHash('sha1').update(JSON.stringify({ options, crf, codec })).digest('hex').slice(0, 12);
    const out = path.join(CACHE, `scene-${key}.${codec === 'y4m' ? 'y4m' : codec === 'libvpx-vp9' ? 'webm' : 'mp4'}`);
    fs.mkdirSync(CACHE, { recursive: true });
    if (!fs.existsSync(out) || !fs.existsSync(`${out}.truth.json`)) await makeClip(options, out, { crf, codec });
    return { path: out, truth: JSON.parse(fs.readFileSync(`${out}.truth.json`, 'utf8')).truth };
}
