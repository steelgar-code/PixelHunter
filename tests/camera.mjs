// Cameras and capture devices (getUserMedia): Chromium's fake camera plays a synthetic scene
// (y4m), the app opens it from the Open menu, runs live (play / pause only) and finds the
// targets; switching source stops the camera. Also the URL checks that point to the camera.
import { launch, ok, BASE_URL } from './lib/env.mjs';
import { sceneClip } from './lib/clips.mjs';
import { checkVideoUrl } from '../src/sources.js';

ok('http:// video on an https:// page: explained (mixed content), not tried', /mixed content/.test(checkVideoUrl('http://192.168.1.20:8080/live.mp4', null, 'https:') || ''));
ok('… fine from http://localhost', checkVideoUrl('http://192.168.1.20:8080/live.mp4', null, 'http:') === null);
ok('… and an http://localhost video from https:// is allowed', checkVideoUrl('http://localhost:8080/a.mp4', null, 'https:') === null);
ok('rtsp:// is explained, with the OBS Virtual Camera way', /OBS/.test(checkVideoUrl('rtsp://192.168.1.20/stream1', null, 'http:') || ''));

const scene = { width: 640, height: 360, frames: 125, fps: 25, camera: 'pan', seed: 31, noise: 2,
    targets: [{ size: 3, contrast: 60, fx: 150, fy: 120, vx: 6 + 2, vy: 2.5 + 0.6 }, { size: 3, contrast: -50, fx: 450, fy: 250, vx: 6 - 1.5, vy: 2.5 + 0.8 }] };
const clip = await sceneClip(scene, { codec: 'y4m' });
const browser = await launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${clip.path}`] });
try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['camera'] });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${BASE_URL}#cards=false`);
    await page.waitForFunction(() => window.__ph && window.__ph.ready, null, { timeout: 90000 });
    await page.click('#openMenu');
    await page.waitForFunction(() => document.querySelectorAll('#camera option').length >= 2, null, { timeout: 5000 }).catch(() => {});
    ok('the Open menu lists the camera', (await page.locator('#camera option').count()) >= 2, await page.locator('#camera option').allTextContents());
    await page.click('#openCamera');
    await page.waitForFunction(() => __ph.results.length >= 30, null, { timeout: 60000 });
    const st = await page.evaluate(() => ({ label: document.getElementById('srcLabel').textContent, time: document.getElementById('time').textContent,
        playing: __ph.loop.playing, live: __ph.loop.live, step: document.getElementById('step').disabled, back: document.getElementById('back').disabled,
        timeline: document.getElementById('timeline').disabled, play: document.getElementById('play').disabled }));
    ok('camera opens live and plays at once', st.live && st.playing && /640×360/.test(st.label) && /live/.test(st.label) && /live/.test(st.time), st);
    ok('… play / pause only (no step, back or timeline)', st.step && st.back && st.timeline && !st.play, st);
    await page.waitForFunction(() => __ph.results.some(r => r.confirmed.length >= 2), null, { timeout: 60000 }).catch(() => {});
    const found = await page.evaluate(() => Math.max(0, ...__ph.results.map(r => r.confirmed.length)));
    ok('the targets are found and confirmed through the camera', found >= 2, found);
    const fps = await page.evaluate(() => __ph.stats && __ph.stats.sourceFps);
    ok('… at the camera’s frame rate (25)', fps && Math.abs(fps - 25) < 3, fps);
    await page.click('#play');
    const n = await page.evaluate(() => __ph.results.length);
    await page.waitForTimeout(800);
    ok('Pause stops processing', (await page.evaluate(() => __ph.results.length)) - n <= 2);
    await page.click('#play');
    await page.waitForFunction(k => __ph.results.length > k + 5, n, { timeout: 15000 }).catch(() => {});
    ok('… Play goes on live', (await page.evaluate(() => __ph.results.length)) > n + 5);
    // another source: the camera is released
    await page.click('#openMenu');
    await page.selectOption('#scene', 'pan-dots');
    await page.click('#openScene');
    await page.waitForFunction(() => /960×540/.test(document.getElementById('srcLabel').textContent) && __ph.loop && !__ph.loop.live, null, { timeout: 30000 });
    ok('switching source releases the camera', await page.evaluate(() => !document.getElementById('video').srcObject));
    ok('no page errors', errors.length === 0, errors);
    await ctx.close();

    // real cameras often report mediaTime 0 (or a stuck value) for every frame: the picture
    // must keep going anyway (seen on a real webcam and OBS Virtual Camera: one frame, then frozen)
    for (const [what, patch] of [['0', 'md.mediaTime = 0;'], ['stuck, no capture time', 'md.mediaTime = 1.5; delete md.captureTime;']]) {
        const c = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['camera'] });
        await c.addInitScript(`(() => {
            const orig = HTMLVideoElement.prototype.requestVideoFrameCallback;
            HTMLVideoElement.prototype.requestVideoFrameCallback = function (cb) {
                return orig.call(this, (now, meta) => { const md = { ...meta }; if (this.srcObject) { ${patch} } cb(now, md); });
            };
        })();`);
        const p = await c.newPage();
        await p.goto(`${BASE_URL}#cards=false`);
        await p.waitForFunction(() => window.__ph && window.__ph.ready, null, { timeout: 90000 });
        await p.click('#openMenu');
        await p.click('#openCamera');
        await p.waitForFunction(() => __ph.results.length >= 20, null, { timeout: 30000 }).catch(() => {});
        const r = await p.evaluate(() => ({ n: __ph.results.length, fps: __ph.stats && __ph.stats.sourceFps, conf: Math.max(0, ...__ph.results.map(x => x.confirmed.length)) }));
        ok(`camera with mediaTime ${what}: keeps playing and detecting`, r.n >= 20 && r.conf >= 1, r);
        await c.close();
    }

    // camera access refused: a clear message
    const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const p2 = await ctx2.newPage();
    await p2.goto(BASE_URL);
    await p2.waitForFunction(() => window.__ph && window.__ph.ready, null, { timeout: 90000 });
    await p2.evaluate(() => { navigator.mediaDevices.getUserMedia = () => Promise.reject(Object.assign(new Error('denied'), { name: 'NotAllowedError' })); });
    await p2.click('#openMenu');
    await p2.click('#openCamera');
    await p2.waitForFunction(() => !document.getElementById('banner').hidden, null, { timeout: 10000 }).catch(() => {});
    ok('camera access refused: says how to allow it', /not allowed/.test(await p2.textContent('#banner')), await p2.textContent('#banner'));
    await ctx2.close();
} finally {
    await browser.close();
}
