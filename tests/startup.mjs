// Startup: OpenCV.js loads and passes the required-function check; a broken or missing build
// stops the app with a message naming the problem.
import { launch, ok, openApp, BASE_URL } from './lib/env.mjs';

const browser = await launch();
try {
    {
        const { page, errors } = await openApp(browser);
        const r = await page.evaluate(() => ({ ready: __ph.ready, error: __ph.error, status: document.getElementById('cvStatus').textContent,
            banner: document.getElementById('banner').hidden, ms: __ph.cvState.ms, open: document.querySelector('[data-open]').disabled }));
        ok('OpenCV.js loads and passes the check', r.ready && !r.error, r);
        ok('status names the version', r.status.includes('4.12.0 ready'), r.status);
        ok('no banner, file button enabled', r.banner && !r.open);
        ok('load time recorded', r.ms > 0 && r.ms < 60000, Math.round(r.ms));
        const mats = await page.evaluate(() => { const m = new cv.Mat(2, 2, cv.CV_8U); const ok = m.rows === 2; m.delete(); return ok; });
        ok('cv.Mat usable after startup (thenable removed)', mats && await page.evaluate(() => typeof cv.then === 'undefined'));
        ok('no page errors', errors.length === 0, errors);
        await page.close();
    }
    {
        const page = await browser.newPage();
        await page.route('**/vendor/opencv-*.js', r => r.fulfill({ contentType: 'text/javascript',
            body: 'window.cv = { Mat: function () {}, CV_8U: 0, RANSAC: 8 };' }));
        await page.goto(BASE_URL);
        await page.waitForFunction(() => window.__ph && window.__ph.error, null, { timeout: 30000 });
        const r = await page.evaluate(() => ({ missing: __ph.missing, banner: document.getElementById('banner').textContent,
            status: document.getElementById('cvStatus').textContent, open: document.querySelector('[data-open]').disabled }));
        ok('incomplete build: banner names missing functions', r.banner.includes('goodFeaturesToTrack') && r.banner.includes('findHomography'), r.banner.slice(0, 120));
        ok('incomplete build: present names are not listed', !r.missing.includes('Mat') && !r.missing.includes('RANSAC') && r.missing.includes('INTER_LINEAR'));
        ok('incomplete build: app stopped', r.status === 'OpenCV.js incomplete' && r.open);
        await page.close();
    }
    {
        const page = await browser.newPage();
        await page.route('**/vendor/opencv-*.js', r => r.fulfill({ status: 404, body: '' }));
        await page.goto(BASE_URL);
        await page.waitForFunction(() => window.__ph && window.__ph.error, null, { timeout: 30000 });
        const banner = await page.evaluate(() => document.getElementById('banner').textContent);
        ok('missing file: banner says it could not be loaded', banner.includes('could not be loaded'), banner);
        await page.close();
    }
} finally {
    await browser.close();
}
