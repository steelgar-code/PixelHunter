// Frame sources. Every source has the same shape, so the frame loop and the pipeline never
// know where frames come from:
//   { kind, label, isLive, start(video) -> Promise<void>, stop(video) }
// start() leaves the <video> loaded (metadata known) but paused.

function waitForMetadata(video) {
    return new Promise((resolve, reject) => {
        const done = () => { cleanup(); resolve(); };
        const fail = () => {
            cleanup();
            const code = video.error && video.error.code;
            reject(new Error(code === 4
                ? 'This browser cannot play this file (unsupported format or codec).'
                : 'The video could not be loaded.'));
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
