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
        file,                       // for the clip id of its labels
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
        return `Browsers can't play ${u.protocol.slice(0, -1).toUpperCase()} streams. Put a gateway such as MediaMTX in between and open its WebRTC or HLS address (the Open menu suggests them), or open it in OBS (Media Source) and use OBS's Virtual Camera here (Open → Camera).`;
    }
    if (!/^https?:$/.test(u.protocol)) return 'Only http:// and https:// links can be opened.';
    if (pageProtocol === 'https:' && u.protocol === 'http:' && !LOCAL_HOST.test(u.hostname)) {
        return 'This page is served over https://, and browsers block http:// video on it (mixed content), so this link can\'t be opened here. Run PixelHunter from your own computer (python3 -m http.server in its folder, then http://localhost:8000/) or serve the video over https://.';
    }
    if (NOT_A_FILE.test(u.hostname + u.pathname)) {
        return `${u.hostname} links open a web page with a player, not the video itself. Use a direct link to the video file (ending in .mp4, .webm, …), or download the video and open the file.`;
    }
    if (/\.m3u8$/i.test(u.pathname) && video && !video.canPlayType('application/vnd.apple.mpegurl')) {
        return 'This is an HLS stream (.m3u8): open it with the type "HLS stream" (or Auto).';
    }
    return null;
}

// --- streams: HLS and WebRTC (WHEP), e.g. from a MediaMTX gateway -------------------------------
//
// HLS plays through hls.js (vendor/, loaded on first use; Safari can play it natively): it fetches
// the segments itself, so the picture is readable when the server allows other sites (CORS),
// which MediaMTX does by default. WHEP is WebRTC with a single HTTP request to set it up: the
// lowest delay (well under a second), no CORS on the picture (it arrives as a MediaStream).

export const HLS_URL = 'vendor/hls-1.7.3.light.min.js';
let hlsLoading = null;
function loadHls() {
    if (typeof window !== 'undefined' && window.Hls) return Promise.resolve(window.Hls);
    hlsLoading ??= new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = HLS_URL;
        s.onload = () => (window.Hls ? resolve(window.Hls) : reject(new Error('hls.js did not load')));
        s.onerror = () => { hlsLoading = null; reject(new Error(`Could not load ${HLS_URL}`)); };
        document.head.append(s);
    });
    return hlsLoading;
}

// What a URL is: 'hls', 'whep', 'gateway' (RTSP / RTMP / SRT: needs one), or 'file'.
// chosen: the type picked in the Open menu ('auto' to tell by the URL).
export function streamKind(href, chosen = 'auto') {
    if (chosen && chosen !== 'auto') return chosen;
    let u;
    try { u = new URL(String(href).trim()); } catch { return 'file'; }
    if (/^(rtsps?|rtmps?|srt):$/.test(u.protocol)) return 'gateway';
    if (/\.m3u8$/i.test(u.pathname)) return 'hls';
    if (/\/whep\/?$/i.test(u.pathname)) return 'whep';
    return 'file';
}

// The addresses MediaMTX (default ports) serves a camera's RTSP / RTMP stream at, for a browser:
// { path, whep, hls }, or null. rtsp://cam-host:8554/garden → http://cam-host:8889/garden/whep …
// For a camera's own RTSP address (not the gateway's), `path` is a name for gateway/mediamtx.yml.
export function gatewayUrls(href) {
    let u;
    try { u = new URL(String(href).trim()); } catch { return null; }
    if (!/^(rtsps?|rtmps?):$/.test(u.protocol)) return null;
    const path = u.pathname.replace(/^\/+|\/+$/g, '') || 'stream';
    const host = u.hostname.includes(':') ? `[${u.hostname}]` : u.hostname;
    return { path, whep: `http://${host}:8889/${path}/whep`, hls: `http://${host}:8888/${path}/index.m3u8` };
}

// Checks a stream URL (http(s) only, mixed content); an error message or null.
function checkStreamUrl(url, pageProtocol = typeof location !== 'undefined' ? location.protocol : 'http:') {
    let u;
    try { u = new URL(url); } catch { return 'That is not a complete URL (it should start with http:// or https://).'; }
    if (!/^https?:$/.test(u.protocol)) return 'Only http:// and https:// stream addresses can be opened.';
    if (pageProtocol === 'https:' && u.protocol === 'http:' && !LOCAL_HOST.test(u.hostname)) {
        return 'This page is served over https://, and browsers block http:// streams on it (mixed content). Run PixelHunter from your own computer (python3 -m http.server in its folder, then http://localhost:8000/), or turn on HTTPS in the gateway (MediaMTX: hlsEncryption / webrtcEncryption with a certificate the browser trusts).';
    }
    return null;
}

const streamName = url => { try { const u = new URL(url); return decodeURIComponent(u.pathname.replace(/\/(whep|index\.m3u8)\/?$/i, '').split('/').filter(Boolean).pop() || u.hostname); } catch { return url; } };

// An HLS stream (.m3u8): live (no end: play / pause only) or a recording (seekable, like a file).
export function hlsSource(href) {
    const url = String(href).trim();
    const name = streamName(url);
    let hls = null;
    const src = {
        kind: 'hls',
        label: `${name} (HLS)`,
        url,
        isLive: false,
        async start(video) {
            const bad = checkStreamUrl(url);
            if (bad) throw new Error(bad);
            video.srcObject = null;
            video.muted = true;
            video.playsInline = true;
            video.loop = false;
            let Hls = null;
            try { Hls = await loadHls(); } catch { Hls = null; }
            const ready = waitForMetadata(video, { failed: `Could not play the HLS stream ${name}.` });
            if (Hls && Hls.isSupported()) {
                hls = new Hls({ lowLatencyMode: true, backBufferLength: 30, enableWorker: true });
                const fatal = new Promise((_, reject) => hls.on(Hls.Events.ERROR, (_e, data) => {
                    if (!data.fatal) return;
                    const code = data.response && data.response.code;
                    reject(new Error(data.type === Hls.ErrorTypes.NETWORK_ERROR
                        ? code === 404 ? `No stream at ${url} (404): is the camera publishing to the gateway, and is the path right?`
                            : `Could not load the HLS stream${code ? ` (HTTP ${code})` : ''}: the gateway isn't reachable at that address, or it doesn't let other sites read it (CORS).`
                        : `The HLS stream could not be played (${data.details}).`));
                }));
                const live = new Promise(resolve => hls.on(Hls.Events.LEVEL_LOADED, (_e, data) => resolve(!!(data.details && data.details.live))));
                hls.loadSource(url);
                hls.attachMedia(video);
                await Promise.race([ready, fatal, new Promise((_, reject) => setTimeout(() => reject(new Error(
                    `No picture from the HLS stream ${name} within 20 s (is the camera sending?).`)), 20000))]);
                src.isLive = await Promise.race([live, new Promise(r => setTimeout(() => r(!Number.isFinite(video.duration)), 3000))]);
            } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
                video.crossOrigin = 'anonymous';
                video.src = url;
                await ready;
                src.isLive = !Number.isFinite(video.duration);
            } else {
                throw new Error('This browser can play neither HLS directly nor through hls.js (no Media Source Extensions).');
            }
            if (src.isLive) src.label = `${name} (HLS, live)`;
        },
        stop(video) {
            if (hls) hls.destroy();
            hls = null;
            video.pause();
            video.removeAttribute('src');
            video.removeAttribute('crossorigin');
            video.load();
        },
    };
    return src;
}

// Waits until ICE gathering is complete (WHEP sends one offer with all candidates), or `ms`.
function iceGathered(pc, ms) {
    if (pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise(resolve => {
        const t = setTimeout(done, ms);
        function done() { clearTimeout(t); pc.removeEventListener('icegatheringstatechange', check); resolve(); }
        function check() { if (pc.iceGatheringState === 'complete') done(); }
        pc.addEventListener('icegatheringstatechange', check);
    });
}

// A WebRTC stream through WHEP (MediaMTX: http://host:8889/<path>/whep): live. onEnded: called
// when the connection drops while it is open.
export function whepSource(href, { onEnded } = {}) {
    const url = String(href).trim();
    const name = streamName(url);
    let pc = null, session = null, stream = null, open = false;
    const src = {
        kind: 'whep',
        label: `${name} (WebRTC)`,
        url,
        isLive: true,
        async start(video) {
            const bad = checkStreamUrl(url);
            if (bad) throw new Error(bad);
            if (typeof RTCPeerConnection === 'undefined') throw new Error('This browser has no WebRTC.');
            pc = new RTCPeerConnection({ bundlePolicy: 'max-bundle' });
            pc.addTransceiver('video', { direction: 'recvonly' });
            const track = new Promise(resolve => { pc.ontrack = e => resolve(e.streams[0] || new MediaStream([e.track])); });
            await pc.setLocalDescription(await pc.createOffer());
            await iceGathered(pc, 2000);
            let res;
            try {
                res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/sdp' }, body: pc.localDescription.sdp });
            } catch {
                throw new Error(`Could not reach ${new URL(url).host}: the gateway isn't running there, the address or port is wrong (MediaMTX: 8889), or it doesn't let other sites connect (CORS).`);
            }
            if (res.status === 404) throw new Error(`No stream at ${url} (404): is the camera publishing to the gateway, and is the path right?`);
            if (res.status === 401 || res.status === 403) throw new Error('The gateway wants a user name and password for this stream (MediaMTX: authInternalUsers); allow reading without one for PixelHunter.');
            if (!res.ok) throw new Error(`The gateway refused the WebRTC request (HTTP ${res.status}).`);
            const loc = res.headers.get('Location');
            session = loc ? new URL(loc, url).href : null;
            await pc.setRemoteDescription({ type: 'answer', sdp: await res.text() });
            stream = await Promise.race([track, new Promise((_, reject) => setTimeout(() => reject(new Error(
                'The gateway answered, but no picture arrived: the WebRTC connection could not be made (MediaMTX: set webrtcAdditionalHosts to the gateway\'s LAN address; a firewall may block UDP 8189).')), 10000))]);
            pc.addEventListener('connectionstatechange', () => {
                if (open && ['failed', 'closed', 'disconnected'].includes(pc.connectionState) && onEnded) onEnded(pc.connectionState);
            });
            video.removeAttribute('src');
            video.muted = true;
            video.playsInline = true;
            video.loop = false;
            const ready = waitForMetadata(video, { failed: `${name} sends no picture.` });
            video.srcObject = stream;
            await Promise.race([ready, new Promise((_, reject) => setTimeout(() => reject(new Error(
                'Connected, but no picture arrived: the browser may not decode this camera\'s codec over WebRTC (H.265, or H.264 High profile in some browsers): try HLS, or set the camera to H.264 Main / Baseline.')), 15000))]);
            open = true;
        },
        stop(video) {
            open = false;
            if (session) fetch(session, { method: 'DELETE' }).catch(() => {});
            session = null;
            if (stream) for (const t of stream.getTracks()) t.stop();
            stream = null;
            if (pc) pc.close();
            pc = null;
            video.pause();
            video.srcObject = null;
        },
    };
    return src;
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
