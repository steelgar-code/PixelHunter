// Frame sources. Every source has the same shape, so the frame loop and the pipeline never
// know where frames come from:
//   { kind, label, isLive, start(video) -> Promise<void>, stop(video) }
// start() leaves the <video> loaded (metadata known) but paused.

function waitForMetadata(video, { unsupported = 'This browser cannot play this file (unsupported format or codec).', failed = 'The video could not be loaded.' } = {}) {
    return new Promise((resolve, reject) => {
        const done = () => { cleanup(); resolve(); };
        const fail = () => {
            cleanup();
            const code = video.error && video.error.code;
            reject(new Error(code === 4 ? unsupported : failed));
        };
        const cleanup = () => {
            video.removeEventListener('loadeddata', done);
            video.removeEventListener('error', fail);
        };
        video.addEventListener('loadeddata', done);
        video.addEventListener('error', fail);
    });
}

export function fileSource(file) {
    let url = null;
    return {
        kind: 'file',
        label: file.name,
        isLive: false,
        async start(video) {
            url = URL.createObjectURL(file);
            video.srcObject = null;
            video.muted = true;
            video.playsInline = true;
            video.loop = false;
            const ready = waitForMetadata(video);
            video.src = url;
            await ready;
        },
        stop(video) {
            video.pause();
            video.removeAttribute('src');
            video.load();
            if (url) URL.revokeObjectURL(url);
            url = null;
        },
    };
}

// Pages that show a video rather than being one (the player page, not the file).
const NOT_A_FILE = /(^|\.)(youtube\.com|youtu\.be|vimeo\.com|twitch\.tv|facebook\.com|instagram\.com|tiktok\.com|dropbox\.com\/s\/|drive\.google\.com)/i;

// Checks a URL before trying it; returns an error message or null.
export function checkVideoUrl(text, video) {
    let u;
    try {
        u = new URL(String(text).trim());
    } catch {
        return 'That is not a complete URL (it should start with https://).';
    }
    if (!/^https?:$/.test(u.protocol)) return 'Only http:// and https:// links can be opened.';
    if (NOT_A_FILE.test(u.hostname + u.pathname)) {
        return `${u.hostname} links open a web page with a player, not the video itself. Use a direct link to the video file (ending in .mp4, .webm, …), or download the video and open the file.`;
    }
    if (/\.m3u8$/i.test(u.pathname) && video && !video.canPlayType('application/vnd.apple.mpegurl')) {
        return 'This is an HLS stream (.m3u8), which this browser cannot play directly. Safari can; in Chrome or Edge use a direct .mp4 / .webm link.';
    }
    return null;
}

// A video at a URL: a file (mp4, webm, …) or a stream the browser plays natively. The server
// must allow other sites to read it (CORS: Access-Control-Allow-Origin), or the pixels can't be
// read for detection. Streams without an end (duration Infinity) are live: no seeking.
export function urlSource(href) {
    const url = String(href).trim();
    const name = (() => {
        try {
            const u = new URL(url);
            return decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || u.hostname);
        } catch {
            return url;
        }
    })();
    const src = {
        kind: 'url',
        label: name,
        url,
        isLive: false,
        async start(video) {
            const bad = checkVideoUrl(url, video);
            if (bad) throw new Error(bad);
            video.srcObject = null;
            video.muted = true;
            video.playsInline = true;
            video.loop = false;
            video.crossOrigin = 'anonymous';    // pixels must be readable: needs CORS from the server
            const ready = waitForMetadata(video, {
                unsupported: `Could not open ${name}: the server refused other sites (no CORS permission), the link is not a video file, or the format isn't supported here. Try downloading it and opening the file.`,
                failed: `Could not load ${name}: the server could not be reached or the download stopped.`,
            });
            video.src = url;
            await ready;
            src.isLive = !Number.isFinite(video.duration);
            if (src.isLive) src.label = `${name} (live)`;
        },
        stop(video) {
            video.pause();
            video.removeAttribute('src');
            video.removeAttribute('crossorigin');
            video.load();
        },
    };
    return src;
}
