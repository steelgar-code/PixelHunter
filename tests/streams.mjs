// Stream sources (src/sources.js): telling URLs apart, the gateway hint for RTSP / RTMP, an HLS
// recording (seekable, as a file; Benchmark runs on it), and, through MediaMTX
// (gateway/mediamtx.yml; tests/lib/mediamtx.mjs finds or builds it), live WebRTC (WHEP) and
// live HLS from a published RTSP stream, a missing path, and a stream that stops.
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { launch, ok, openApp, showTab } from './lib/env.mjs';
import { sceneClip, CACHE } from './lib/clips.mjs';
import { findMediamtx, startMediamtx, publish } from './lib/mediamtx.mjs';
import { streamKind, gatewayUrls } from '../src/sources.js';

// --- telling URLs apart (pure) ---
ok('Auto: .m3u8 is HLS, …/whep is WebRTC, rtsp / rtmp need a gateway, the rest a file',
    streamKind('http://h:8888/cam/index.m3u8') === 'hls' && streamKind('http://h:8889/cam/whep') === 'whep' && streamKind('http://h:8889/cam/whep/') === 'whep'
    && streamKind('rtsp://h:8554/cam') === 'gateway' && streamKind('rtmp://h/live/x') === 'gateway' && streamKind('srt://h:8890') === 'gateway'
    && streamKind('https://x/v.mp4') === 'file' && streamKind('not a url') === 'file');
ok('a chosen type wins over the URL', streamKind('https://x/v.mp4', 'hls') === 'hls' && streamKind('http://h/a.m3u8', 'file') === 'file');
const g = gatewayUrls('rtsp://192.168.1.20:8554/garden/cam1');
ok('MediaMTX addresses for an RTSP path (default ports)', g && g.path === 'garden/cam1' && g.whep === 'http://192.168.1.20:8889/garden/cam1/whep'
    && g.hls === 'http://192.168.1.20:8888/garden/cam1/index.m3u8' && gatewayUrls('rtmp://h/live/drone').whep === 'http://h:8889/live/drone/whep', g);

const dot = (size, contrast, fx, fy, vx, vy) => ({ size, contrast, fx, fy, vx, vy });
const scene = { width: 640, height: 360, noise: 2, frames: 100, camera: 'pan', seed: 4, targets: [dot(3, 40, 100, 100, 7, 3), dot(3, -40, 200, 250, 7.5, 2)] };
const clip = await sceneClip(scene, { gop: 25 });
// an HLS recording of it, served by the test server
const vodDir = path.join(CACHE, `hlsvod-${path.basename(clip.path, '.mp4')}`);
if (!fs.existsSync(path.join(vodDir, 'index.m3u8'))) {
    fs.mkdirSync(vodDir, { recursive: true });
    const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', clip.path, '-c', 'copy', '-f', 'hls', '-hls_time', '1', '-hls_playlist_type', 'vod',
        '-hls_segment_filename', path.join(vodDir, 'seg%03d.ts'), path.join(vodDir, 'index.m3u8')]);
    if (r.status !== 0) throw new Error(`ffmpeg hls failed: ${r.stderr}`);
}

const openUrlIn = async (page, url, kind = 'auto') => {
    await page.evaluate(() => { __ph.results.length = 0; document.getElementById('banner').hidden = true; });
    if (await page.isHidden('#sourceMenu')) await page.click('#openMenu');
    await page.fill('#srcUrl', url);
    await page.selectOption('#srcKind', kind);
    await page.click('#urlForm button[type=submit]');
};
const state = page => page.evaluate(() => ({ label: document.getElementById('srcLabel').textContent, res: __ph.results.length, live: !!(__ph.loop && __ph.loop.live),
    banner: document.getElementById('banner').hidden ? null : document.getElementById('banner').textContent, conf: __ph.lastResult ? __ph.lastResult.confirmed.length : 0,
    play: !document.getElementById('play').disabled, step: !document.getElementById('step').disabled }));

const browser = await launch();
try {
    const { page, errors } = await openApp(browser, { hash: 'mode=everyFrame', viewport: { width: 1440, height: 900 } });

    // --- an HLS recording: seekable like a file ---
    const vodUrl = new URL(`tests/.cache/${path.basename(vodDir)}/index.m3u8`, process.env.BASE_URL || 'http://localhost:8765/').href;
    await openUrlIn(page, vodUrl);
    await page.waitForFunction(() => __ph.results.length >= 1 && document.getElementById('loading').hidden, null, { timeout: 30000 });
    let st = await state(page);
    ok('an HLS recording opens through hls.js: not live, every control there', /\(HLS\)/.test(st.label) && !st.live && st.step && st.play && /640×360/.test(st.label), st);
    const f0 = await page.evaluate(() => __ph.shown.frame);
    await page.click('#step');
    await page.waitForFunction(f => __ph.shown.frame === f + 1, f0, { timeout: 10000 });
    ok('… Step goes exactly one frame', true);
    ok('… labels for it (clip id from its address)', await page.evaluate(() => !!__ph.labels.set));
    await showTab(page, 'bench');
    await page.evaluate(() => { for (const b of document.querySelectorAll('#benchSets input[type=checkbox]')) if (b.checked !== (b.dataset.key === 'current')) b.click(); });
    await page.click('#benchRun');
    await page.waitForFunction(() => !__ph.bench.running && __ph.bench.result, null, { timeout: 180000 });
    const [cur] = await page.evaluate(() => __ph.bench.scores());
    ok('… a Benchmark run on it (its own hidden player through hls.js): every frame', cur.frames >= 95 && cur.frames <= 100 && cur.tracks >= 2, { frames: cur.frames, tracks: cur.tracks });
    await showTab(page, 'objects');

    // --- an RTSP address: the gateway's addresses offered ---
    await openUrlIn(page, 'rtsp://localhost:8554/test');
    ok('rtsp://: not opened; the menu offers MediaMTX\'s WebRTC and HLS addresses', await page.isVisible('#urlHint') && await page.isVisible('#sourceMenu')
        && (await page.textContent('#urlHint button:nth-of-type(1)')).includes('http://localhost:8889/test/whep')
        && (await page.textContent('#urlHint button:nth-of-type(2)')).includes('http://localhost:8888/test/index.m3u8'), await page.textContent('#urlHint'));

    // --- live through MediaMTX ---
    const m = findMediamtx();
    if (!m.bin) {
        console.log(`SKIP live gateway checks: ${m.why}`);
    } else {
        const mtx = await startMediamtx(m.bin);
        let pub = await publish(clip.path, 'test');
        try {
            await page.click('#urlHint button:nth-of-type(1)');
            await page.waitForFunction(() => __ph.results.length >= 20 || !document.getElementById('banner').hidden, null, { timeout: 40000 });
            st = await state(page);
            ok('WebRTC (WHEP) from the gateway: live, frames processed, Play / Pause only', /\(WebRTC\)/.test(st.label) && st.live && st.res >= 20 && !st.banner && !st.step, st);
            await page.waitForFunction(() => __ph.lastResult && __ph.lastResult.confirmed.length >= 1, null, { timeout: 20000 }).catch(() => {});
            ok('… objects found in it', (await state(page)).conf >= 1);
            ok('… the type is remembered with the address', await page.evaluate(() => document.getElementById('srcKind').value === 'whep' && document.getElementById('srcUrl').value.endsWith('/test/whep')));

            await openUrlIn(page, 'http://localhost:8888/test/index.m3u8');
            await page.waitForFunction(() => __ph.results.length >= 20 || !document.getElementById('banner').hidden, null, { timeout: 40000 });
            st = await state(page);
            ok('HLS from the gateway: live, frames processed', /\(HLS, live\)/.test(st.label) && st.live && st.res >= 20 && !st.banner, st);

            await openUrlIn(page, 'http://localhost:8889/nothing/whep');
            await page.waitForFunction(() => !document.getElementById('banner').hidden, null, { timeout: 20000 });
            ok('a path with no stream: says so (404)', /No stream at .*404/.test((await state(page)).banner), (await state(page)).banner);
            await openUrlIn(page, 'http://localhost:8888/nothing/index.m3u8');
            await page.waitForFunction(() => !document.getElementById('banner').hidden, null, { timeout: 30000 });
            ok('… also over HLS', /No stream|Could not load the HLS stream/.test((await state(page)).banner), (await state(page)).banner);

            // the publisher stops while watching over WebRTC
            await openUrlIn(page, 'http://localhost:8889/test/whep', 'whep');
            await page.waitForFunction(() => __ph.results.length >= 5, null, { timeout: 40000 });
            pub.stop();
            pub = null;
            await page.waitForFunction(() => !document.getElementById('banner').hidden, null, { timeout: 40000 }).catch(() => {});
            ok('the stream stops: says so, playback stops', /WebRTC stream stopped/.test((await state(page)).banner || ''), (await state(page)).banner);
        } finally {
            if (pub) pub.stop();
            mtx.stop();
        }
    }
    ok('no page errors', errors.length === 0, errors);
} finally {
    await browser.close();
}
