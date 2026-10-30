// Shared test setup: browser launch, the app URL and the PASS / FAIL reporter.
//   BASE_URL       app under test (run.mjs starts a local server and sets it)
//   CHROMIUM_PATH  browser to use (default: Playwright's own, or /opt/pw-browsers/chromium if present)
import { chromium } from 'playwright';
import fs from 'fs';

export const BASE_URL = process.env.BASE_URL || 'http://localhost:8765/';

export function launch(options = {}) {
    const path = process.env.CHROMIUM_PATH || (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
    return chromium.launch({ ...(path ? { executablePath: path } : {}), ...options });
}

// Prints PASS / FAIL lines; run.mjs counts them.
export const ok = (name, cond, extra) => console.log(cond ? 'PASS' : 'FAIL', name, extra !== undefined ? JSON.stringify(extra) : '');

// Opens the app and waits for OpenCV.js; collects page errors into the returned array.
export async function openApp(browser, { hash = '', query = '', viewport = { width: 1280, height: 800 } } = {}) {
    const page = await browser.newPage({ viewport });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${BASE_URL}${query ? '?' + query : ''}${hash ? '#' + hash : ''}`);
    await page.waitForFunction(() => window.__ph && (window.__ph.ready || window.__ph.error), null, { timeout: 90000 });
    return { page, errors };
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));
