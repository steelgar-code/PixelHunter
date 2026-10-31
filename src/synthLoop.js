// Frame loop for synthetic scenes: the same interface as frameLoop.js, without a <video>.
// Frames are rendered by synth.js on demand and delivered as ImageData with their ground truth.
//
//   realtime    frame index follows the clock; frames not rendered in time are skipped (gap)
//   everyFrame  every frame in order, paced to the scene's fps at most

import { greyToRgba } from './synth.js';

export function createSyntheticLoop({ scene, onFrame, mode = 'realtime', speed = 1 }) {
    const fps = scene.fps, n = scene.frames;
    const rate = () => fps * speed;      // frames per second of wall time
    let k = -1;                  // last delivered frame
    let seq = 0;
    let playing = false;
    let timer = null;
    let clock = null;            // { t0: performance.now(), k0 } while playing
    let dropped = 0;
    const costs = [];
    const deliveredAt = [];
    let rgba = null;

    // jump: why the previous frames don't connect ('start', 'seek', …), or false
    function deliver(next, jump) {
        const gap = jump || k < 0 ? 0 : Math.max(0, next - k - 1);
        if (!jump) dropped += gap;
        const f = scene.frame(next);
        rgba = greyToRgba(f.grey, rgba && rgba.length === f.grey.length * 4 ? rgba : undefined);
        const imageData = new ImageData(rgba, f.width, f.height);
        k = next;
        const t0 = performance.now();
        try {
            onFrame({ imageData, width: f.width, height: f.height, time: next / fps, frame: next, seq: seq++, gap, jump: !!jump, jumpReason: jump || null, truth: f.truth });
        } finally {
            costs.push(performance.now() - t0);
            if (costs.length > 20) costs.shift();
            deliveredAt.push(t0);
            while (deliveredAt.length && t0 - deliveredAt[0] > 1000) deliveredAt.shift();
        }
    }

    function tick() {
        timer = null;
        if (!playing) return;
        if (k >= n - 1) { playing = false; return; }
        const now = performance.now();
        const due = clock.k0 + Math.floor((now - clock.t0) / 1000 * rate());
        let next;
        if (mode === 'realtime') {
            next = Math.min(n - 1, Math.max(k + 1, due));
        } else {
            next = k + 1;
            if (next > due) {
                // ahead of the clock: wait until this frame is due
                timer = setTimeout(tick, Math.max(0, (next - clock.k0) * 1000 / rate() - (now - clock.t0)));
                return;
            }
            // behind (processing slower than real time): move the clock so we don't race later
            clock = { t0: now, k0: next };
        }
        deliver(next, false);
        if (k >= n - 1) playing = false;
        else timer = setTimeout(tick, 0);
    }

    function stopTimer() {
        if (timer !== null) clearTimeout(timer);
        timer = null;
    }

    return {
        get playing() { return playing; },
        get mode() { return mode; },
        get time() { return Math.max(0, k) / fps; },
        get duration() { return n / fps; },
        async start() {
            k = -1; seq = 0; dropped = 0; costs.length = 0; deliveredAt.length = 0;
            deliver(0, 'start');
        },
        async play() {
            if (k >= n - 1) deliver(0, 'replay from the start');
            playing = true;
            clock = { t0: performance.now() - 1000 / rate(), k0: k };
            stopTimer();
            timer = setTimeout(tick, 0);
        },
        pause() {
            playing = false;
            stopTimer();
        },
        async step() {
            this.pause();
            if (k >= n - 1) return false;
            deliver(k + 1, false);
            return true;
        },
        seek(time) {
            const target = Math.min(n - 1, Math.max(0, Math.round(time * fps)));
            if (playing) clock = { t0: performance.now(), k0: target };
            deliver(target, 'seek');
        },
        setMode(m) {
            mode = m;
            if (playing) clock = { t0: performance.now(), k0: k };
        },
        setSpeed(s) {
            speed = Math.max(0.25, Number(s) || 1);
            if (playing) clock = { t0: performance.now(), k0: k };
        },
        get speed() { return speed; },
        stats() {
            const s = [...costs].sort((a, b) => a - b);
            return {
                sourceFps: fps,
                processedFps: deliveredAt.length,
                dropped,
                recovered: 0,
                rate: 1,
                stepping: false,
                costMs: s.length ? s[Math.min(s.length - 1, Math.floor(s.length * 0.9))] : null,
            };
        },
        destroy() {
            playing = false;
            stopTimer();
        },
    };
}
