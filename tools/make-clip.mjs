// Renders a synthetic scene (src/synth.js) to a video file with ffmpeg, plus a ground-truth
// sidecar (<out>.truth.json: per frame the true H from the previous frame and the target boxes).
//
//   node tools/make-clip.mjs out.mp4 [scene.json] [--crf 18] [--codec libx264|libvpx-vp9|y4m] [--gop 30]
//
// scene.json holds createScene() options (camera, targets, noise, …); without it the default
// scene is used. --gop: frames between keyframes (default: the encoder's). As a module:
// makeClip(sceneOptions, outPath, { crf, codec, gop }).
import fs from 'fs';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { createScene } from '../src/synth.js';

export async function makeClip(sceneOptions, out, { crf = 18, codec = 'libx264', gop = null } = {}) {
    const scene = createScene(sceneOptions);
    const { width: W, height: H, fps } = scene;
    const input = ['-f', 'rawvideo', '-pix_fmt', 'gray', '-s', `${W}x${H}`, '-r', String(fps), '-i', '-'];
    const output = codec === 'y4m'
        ? ['-pix_fmt', 'yuv420p', '-f', 'yuv4mpegpipe']
        : codec === 'libvpx-vp9'
            ? ['-c:v', 'libvpx-vp9', '-crf', String(crf), '-b:v', '0', '-pix_fmt', 'yuv420p']
            : ['-c:v', 'libx264', '-crf', String(crf), ...(gop ? ['-g', String(gop)] : []), '-pix_fmt', 'yuv420p', '-movflags', '+faststart'];
    const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...input, ...output, out],
        { stdio: ['pipe', 'inherit', 'pipe'] });
    let stderr = '';
    ff.stderr.on('data', d => { stderr += d; });
    const done = new Promise((resolve, reject) => {
        ff.on('error', e => reject(new Error(`ffmpeg is needed: ${e.message}`)));
        ff.on('close', code => (code === 0 ? resolve() : reject(new Error(`ffmpeg failed: ${stderr}`))));
    });
    const truth = [];
    for (let k = 0; k < scene.frames; k++) {
        const f = scene.frame(k);
        truth.push(f.truth);
        if (!ff.stdin.write(Buffer.from(f.grey.buffer))) await new Promise(r => ff.stdin.once('drain', r));
    }
    ff.stdin.end();
    await done;
    fs.writeFileSync(`${out}.truth.json`, JSON.stringify({ scene: { ...scene.options, camera: String(scene.options.camera) }, truth }));
    return { out, truth, scene };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const args = process.argv.slice(2);
    const flag = name => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
    const crf = Number(flag('--crf') ?? 18), codec = flag('--codec') ?? 'libx264', gop = flag('--gop');
    const [out, sceneFile] = args;
    if (!out) {
        console.error('usage: node tools/make-clip.mjs out.mp4 [scene.json] [--crf 18] [--codec libx264|libvpx-vp9|y4m] [--gop 30]');
        process.exit(2);
    }
    const options = sceneFile ? JSON.parse(fs.readFileSync(sceneFile, 'utf8')) : {};
    const r = await makeClip(options, out, { crf, codec, gop: gop ? Number(gop) : null });
    console.log(`${r.out}: ${r.scene.frames} frames, ${r.scene.width}×${r.scene.height} @ ${r.scene.fps} fps`);
}
