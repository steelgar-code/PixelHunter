// Capture a tab or window (getDisplayMedia): another tab plays a synthetic scene at its own size,
// Chromium picks that tab by its title (as the user would in the sharing dialog), and the app
// runs on it live and finds the targets. Stopping sharing and a cancelled dialog are explained.
import path from 'path';
import { launch, ok, BASE_URL } from './lib/env.mjs';
import { sceneClip } from './lib/clips.mjs';

const scene = { width: 640, height: 360, frames: 150, fps: 25, camera: 'pan', seed: 33, noise: 2,
    targets: [{ size: 4, contrast: 70, fx: 150, fy: 120, vx: 6 + 2.5, vy: 2.5 + 0.6 }, { size: 4, contrast: -60, fx: 450, fy: 250, vx: 6 - 2, vy: 2.5 + 0.8 }] };
const clip = await sceneClip(scene, { crf: 16 });
const browser = await launch({ args: ['--auto-select-tab-capture-source-by-title=PH capture source'] });
try {
    // small tabs: the headless browser draws and captures the other tab in software, slowly
    const ctx = await browser.newContext({ viewport: { width: 800, height: 450 } });
    // the tab with the stream, shown filling the tab (as full screen would): with the video in a
    // corner of a black tab there is too little picture for the camera-motion fit
    // (in a context of its own: a process of its own, as a real tab from another site would be)
    const tab = await (await browser.newContext({ viewport: { width: 800, height: 450 } })).newPage();
    await tab.setContent(`<title>PH capture source</title><body style="margin:0;background:#000"><video style="width:100vw;height:100vh;object-fit:contain;display:block" src="${BASE_URL}tests/.cache/${path.basename(clip.path)}" autoplay muted loop></video></body>`);
    await tab.waitForFunction(() => document.querySelector('video').currentTime > 0.2, null, { timeout: 15000 });

    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${BASE_URL}#cards=false&procWidth=640`);
    await page.bringToFront();      // a page in the background gets one frame callback a second
    await page.waitForFunction(() => window.__ph && window.__ph.ready, null, { timeout: 90000 });
    await page.click('#openMenu');
    await page.click('#openCapture');
    await page.waitForFunction(() => __ph.results.length >= 30, null, { timeout: 60000 });
    const st = await page.evaluate(() => ({ label: document.getElementById('srcLabel').textContent, live: __ph.loop.live, playing: __ph.loop.playing,
        size: [document.getElementById('video').videoWidth, document.getElementById('video').videoHeight], step: document.getElementById('step').disabled }));
    ok('a captured tab opens live, at the tab\'s own size (not scaled down)', st.live && st.playing && /Captured tab/.test(st.label) && /live/.test(st.label) && st.size[0] === 800 && st.step, st);
    await page.waitForFunction(() => __ph.results.some(r => r.confirmed.length >= 2), null, { timeout: 60000 }).catch(() => {});
    const found = await page.evaluate(() => Math.max(0, ...__ph.results.map(r => r.confirmed.length)));
    ok('the targets in the captured video are found and confirmed', found >= 2, found);
    // sharing stopped from the browser's bar
    await page.evaluate(() => document.getElementById('video').srcObject.getVideoTracks()[0].dispatchEvent(new Event('ended')));
    await page.waitForTimeout(300);
    ok('sharing stopped: paused, and the message says how to pick it again', /Sharing was stopped/.test(await page.textContent('#banner')) && !(await page.evaluate(() => __ph.loop.playing)) && await page.isDisabled('#play'));
    ok('no page errors', errors.length === 0, errors);

    // the dialog cancelled
    await page.evaluate(() => { navigator.mediaDevices.getDisplayMedia = () => Promise.reject(Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' })); });
    await page.click('#openMenu');
    await page.click('#openCapture');
    await page.waitForFunction(() => /cancelled/.test(document.getElementById('banner').textContent), null, { timeout: 10000 }).catch(() => {});
    ok('dialog cancelled: says so', /cancelled/.test(await page.textContent('#banner')), await page.textContent('#banner'));
    await ctx.close();
} finally {
    await browser.close();
}
