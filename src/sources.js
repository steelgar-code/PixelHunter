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

// Checks a URL before trying it; returns an error message or null. pageProtocol: the app's own
// ('https:' on GitHub Pages), for the mixed-content check.
const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/i;
export function checkVideoUrl(text, video, pageProtocol = typeof location !== 'undefined' ? location.protocol : 'http:') {
    let u;
    try {
        u = new URL(String(text).trim());
    } catch {
        return 'That is not a complete URL (it should start with https://).';
    }
    if (u.protocol === 'rtsp:' || u.protocol === 'rtmp:' || u.protocol === 'rtmps:' || u.protocol === 'srt:') {
        return `Browsers can't play ${u.protocol.slice(0, -1).toUpperCase()} streams. Open it in OBS (Media Source) and use OBS's Virtual Camera here (Open → Camera), or put a gateway such as MediaMTX in between.`;
    }
    if (!/^https?:$/.test(u.protocol)) return 'Only http:// and https:// links can be opened.';
    if (pageProtocol === 'https:' && u.protocol === 'http:' && !LOCAL_HOST.test(u.hostname)) {
        return 'This page is served over https://, and browsers block http:// video on it (mixed content), so this link can\'t be opened here. Run PixelHunter from your own computer (python3 -m http.server in its folder, then http://localhost:8000/) or serve the video over https://.';
    }
    if (NOT_A_FILE.test(u.hostname + u.pathname)) {
        return `${u.hostname} links open a web page with a player, not the video itself. Use a direct link to the video file (ending in .mp4, .webm, …), or download the video and open the file.`;
    }
    if (/\.m3u8$/i.test(u.pathname) && video && !video.canPlayType('application/vnd.apple.mpegurl')) {
        return 'This is an HLS stream (.m3u8), which this browser cannot play directly. Safari can; in Chrome or Edge use a direct .mp4 / .webm link.';
    }
    return null;
}

// Does the URL play in a <video> that doesn't ask for its pixels (no CORS)? Resolves within ms.
function playsWithoutCors(url, ms = 8000) {
    return new Promise(resolve => {
        const v = document.createElement('video');
        v.muted = true;
        v.preload = 'metadata';
        const end = ok => { clearTimeout(timer); v.removeAttribute('src'); v.load(); resolve(ok); };
        const timer = setTimeout(() => end(false), ms);
        v.addEventListener('loadedmetadata', () => end(true), { once: true });
        v.addEventListener('error', () => end(false), { once: true });
        v.src = url;
    });
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
            try {
                await ready;
            } catch (e) {
                // the browser says the same for "no CORS permission" and "not a playable video":
                // try once more without asking for the pixels to tell them apart
                if (await playsWithoutCors(url)) {
                    throw new Error(`${name} plays, but its server doesn't let other sites read the picture (no CORS permission: an Access-Control-Allow-Origin header), which detection needs. Ask for that header on the server, put a proxy that adds it in front, or open the video in OBS and use its Virtual Camera here (Open → Camera).`);
                }
                throw e;
            }
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

// Cameras and capture devices the browser can see: [{ deviceId, label }]. Labels are empty until
// camera access has been allowed once (then they are named "Camera 1", …).
export async function listCameras() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return [];
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter(d => d.kind === 'videoinput').map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Camera ${i + 1}` }));
}

// A camera or capture device (a webcam, an HDMI capture card, OBS Virtual Camera, …) through
// getUserMedia: live, no CORS involved. deviceId: one from listCameras(), or null for the default.
// Asks for the highest resolution up to 1920×1080: few-pixel objects need every pixel.
export function cameraSource({ deviceId = null, label = 'Camera' } = {}) {
    let stream = null;
    const src = {
        kind: 'camera',
        label,
        isLive: true,
        deviceId,
        async start(video) {
            if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                throw new Error('Cameras are only available on pages served over https:// or from http://localhost.');
            }
            try {
                stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: {
                    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
                    width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 },
                } });
            } catch (e) {
                throw new Error(cameraError(e));
            }
            const track = stream.getVideoTracks()[0];
            const st = track.getSettings ? track.getSettings() : {};
            src.deviceId = st.deviceId || deviceId;
            src.label = track.label || label;
            video.removeAttribute('src');
            video.muted = true;
            video.playsInline = true;
            video.loop = false;
            const ready = waitForMetadata(video, { failed: `${src.label} sends no picture.` });
            video.srcObject = stream;
            await ready;
            src.fps = st.frameRate || null;
        },
        stop(video) {
            if (stream) for (const t of stream.getTracks()) t.stop();
            stream = null;
            video.pause();
            video.srcObject = null;
        },
    };
    return src;
}

function cameraError(e) {
    switch (e && e.name) {
    case 'NotAllowedError': return 'Camera access was not allowed. Allow it in the address bar (camera icon) and try again.';
    case 'NotFoundError': return 'No camera or capture device found. For OBS: Start Virtual Camera first (OBS → Controls).';
    case 'NotReadableError': return 'The camera can\'t be opened: another app may be using it, or the device stopped responding.';
    case 'OverconstrainedError': return 'That camera is no longer available (unplugged?). Pick one again from the list.';
    default: return `The camera could not be opened${e && e.message ? `: ${e.message}` : ''}.`;
    }
}

// Another tab or a window, through the browser's screen sharing (getDisplayMedia): the user picks
// it in the browser's dialog. A stream opened in its own tab (its address straight in the address
// bar: http:// works there too) comes in without CORS, server or OBS. What comes is the tab as
// drawn, so the video should show at its own size (a large window, or full screen). Asks for the
// native size (no scaling) and up to 30 fps. onEnded: called when sharing is stopped from the
// browser's bar. Chrome and Edge offer tabs; Firefox and Safari windows and screens.
export function displaySource({ onEnded } = {}) {
    let stream = null;
    const src = {
        kind: 'display',
        label: 'Captured tab',
        isLive: true,
        async start(video) {
            if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
                throw new Error('This browser can\'t capture tabs or windows (or the page isn\'t served over https:// or from localhost).');
            }
            try {
                stream = await navigator.mediaDevices.getDisplayMedia({
                    video: { displaySurface: 'browser', resizeMode: 'none', width: { ideal: 3840 }, height: { ideal: 2160 }, frameRate: { ideal: 30 }, cursor: 'never' },
                    audio: false, selfBrowserSurface: 'exclude', surfaceSwitching: 'include', systemAudio: 'exclude',
                });
            } catch (e) {
                throw new Error(e && e.name === 'NotAllowedError' ? 'Capture was cancelled (or not allowed).' : `The tab or window could not be captured${e && e.message ? `: ${e.message}` : ''}.`);
            }
            const track = stream.getVideoTracks()[0];
            const st = track.getSettings ? track.getSettings() : {};
            src.label = `Captured ${st.displaySurface === 'window' ? 'window' : st.displaySurface === 'monitor' ? 'screen' : 'tab'}`;
            track.addEventListener('ended', () => { if (stream && onEnded) onEnded(); });
            video.removeAttribute('src');
            video.muted = true;
            video.playsInline = true;
            video.loop = false;
            const ready = waitForMetadata(video, { failed: 'The captured tab sends no picture.' });
            video.srcObject = stream;
            await ready;
            src.fps = st.frameRate || null;
        },
        stop(video) {
            const s = stream;
            stream = null;
            if (s) for (const t of s.getTracks()) t.stop();
            video.pause();
            video.srcObject = null;
        },
    };
    return src;
}
