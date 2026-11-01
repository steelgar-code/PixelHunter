// Frame loop on top of requestVideoFrameCallback.
//
// Each new video frame is handed to onFrame(frame) with:
//   video   the <video> element, holding exactly this frame during the call
//   width, height, time (mediaTime, s), frame (file frame number, from time / frame duration)
//   seq     frames delivered since the source started
//   gap     source frames skipped since the previous delivered frame (0 = none)
//   jump    true after a seek, a loop or the first frame: the previous frames don't connect
//   jumpReason  why: 'start', 'seek', 'replay from the start', 'the browser seeked',
//           'video time went backwards' (null when jump is false)
//
// Modes:
//   realtime    the video plays at normal speed; frames that arrive while onFrame is busy are
//               skipped (counted in gap / dropped).
//   everyFrame  for files: the playback rate drops to what onFrame can keep up with. A frame
//               that is skipped anyway is gone back for (pause, seek to it, carry on more
//               slowly), so every frame is delivered in order. Below MIN_RATE the loop pauses
//               the video and steps frame by frame instead.
//
// The frame duration comes from mediaTime differences (presentedFrames is not reliable enough
// for this). For files, start() first probes it by seeking forward in small steps until the
// next frame shows; after that, see estimateFrameDuration: real recordings' timestamps jitter
// and the odd pair is nearly the same instant, so one stray difference must not decide it.

export const MIN_RATE = 0.0625;          // lowest playbackRate browsers reliably support
const START_RATE = 0.25;                 // every-frame mode, until the cost is known
const VSYNC_MS = 35;                     // callbacks are tied to rendering: allow ~2 vsyncs
const STEP_TIMEOUT_MS = 1500;
const SAME_FRAME_MS = 150;               // after 'seeked', no new frame within this = same frame
const PROBE_STEP = 1 / 240;              // s; finer than any real frame duration
const PROBE_MAX = 0.25;                  // s; slower than 4 fps is not probed

const MIN_FRAME = 0.005;                 // s; shorter differences are timestamp noise (> 200 fps)
const FIT_TOL = 0.15;                    // a difference within this share of a frame of k frames fits
const FIT_SHARE = 0.85;                  // a duration must fit this share of the differences

// Frame duration from recent mediaTime differences (s). Real-time mode skips frames, so most
// differences are whole multiples of it; timestamps jitter (container time bases, variable-rate
// recordings) and now and then two are nearly the same. Candidates are the differences divided
// by 1..4; the longest that fits FIT_SHARE of the differences wins, refined as their total time
// over their total frames. probe: the duration measured by stepping at the start, preferred
// while it fits. (Was: the shortest difference, which one stray timestamp could make 1.5 ms
// on a 25 fps file, so every frame looked like dozens skipped.)
export function estimateFrameDuration(samples, probe = null) {
    const s = samples.filter(x => x >= MIN_FRAME);
    if (!s.length) return probe && probe >= MIN_FRAME ? probe : null;
    const fitting = d => s.filter(x => { const k = Math.round(x / d); return k >= 1 && Math.abs(x / d - k) < FIT_TOL; });
    const need = Math.ceil(FIT_SHARE * s.length);
    const refine = d => { const f = fitting(d); return f.reduce((a, x) => a + x, 0) / f.reduce((a, x) => a + Math.round(x / d), 0); };
    if (probe && probe >= MIN_FRAME && fitting(probe).length >= need) return refine(probe);
    let best = null;
    for (const x of new Set(s)) {
        for (let k = 1; k <= 4; k++) {
            const d = x / k;
            if (d >= MIN_FRAME && (best === null || d > best) && fitting(d).length >= need) best = d;
        }
    }
    // nothing fits most of them (irregular timestamps): the median of the shortest third
    if (best === null) { const sorted = [...s].sort((a, b) => a - b); return sorted[Math.floor((sorted.length - 1) / 3 / 2)]; }
    return refine(best);
}

export function createFrameLoop({ video, onFrame, mode = 'realtime' }) {
    if (typeof video.requestVideoFrameCallback !== 'function') {
        throw new Error('This browser does not support requestVideoFrameCallback (needed to read video frames).');
    }

    let handle = null;
    let last = null;            // time of the last delivered frame
    let seq = 0;
    let jumpPending = true;
    let speed = 1;              // playback speed: real-time mode plays at it, every-frame mode at most at it
    let jumpWhy = 'start';      // reason for the pending jump
    const markJump = why => { jumpPending = true; jumpWhy = why; };
    let ownSeek = false;
    let playing = false;        // what the user asked for; the video may be paused while stepping
    let stepping = false;       // every-frame mode below MIN_RATE: driving the video by seeks
    let stepWaiter = null;
    let probing = false;
    let repairing = false;      // every-frame mode: going back for a skipped frame
    const dtSamples = [];
    let dur = null;             // frame duration estimate, s
    let probed = null;          // frame duration measured by probing at the start, s
    const costs = [];           // recent onFrame costs, ms
    let safety = 1;
    let dropped = 0;
    let recovered = 0;          // skipped frames gone back for in every-frame mode
    const deliveredAt = [];     // performance.now() of recent deliveries, for processed FPS

    function arm() {
        if (handle === null) handle = video.requestVideoFrameCallback(onVideoFrame);
    }

    function costP90() {
        if (!costs.length) return null;
        const s = [...costs].sort((a, b) => a - b);
        return s[Math.min(s.length - 1, Math.floor(s.length * 0.9))];
    }

    function onVideoFrame(now, md) {
        handle = null;
        // taken now: a step started from inside this call must wait for the next frame
        const waiter = stepWaiter;
        stepWaiter = null;
        const t = md.mediaTime;
        if (probing) {
            if (waiter) waiter(t);
            return;
        }
        if (last !== null && !jumpPending && t === last) {
            // the same frame again (a seek that landed on it): not new
            arm();
            if (waiter) waiter('same');
            return;
        }
        let gap = 0;
        let jump = jumpPending, jumpReason = jumpPending ? jumpWhy : null;
        if (last !== null && !jump) {
            const dt = t - last;
            if (dt < 0) {
                jump = true;
                jumpReason = 'video time went backwards';
            } else {
                dtSamples.push(dt);
                if (dtSamples.length > 60) dtSamples.shift();
                dur = estimateFrameDuration(dtSamples, probed);
                gap = Math.max(0, Math.round(dt / dur) - 1);
            }
        }
        if (gap > 0 && mode === 'everyFrame' && playing && !stepping && !repairing) {
            repairGap();
            if (waiter) waiter('same');
            return;
        }
        jumpPending = false;
        last = t;
        if (!jump) dropped += gap;

        const frame = {
            video, width: md.width, height: md.height, time: t,
            frame: dur ? Math.round(t / dur) : null, seq: seq++, gap, jump, jumpReason,
        };
        const t0 = performance.now();
        try {
            onFrame(frame);
        } finally {
            costs.push(performance.now() - t0);
            if (costs.length > 20) costs.shift();
            deliveredAt.push(t0);
            while (deliveredAt.length && t0 - deliveredAt[0] > 1000) deliveredAt.shift();
            if (mode === 'everyFrame') adaptRate(gap, jump);
            if (!video.paused || stepping) arm();
            if (waiter) waiter('ok');
        }
    }

    // every-frame mode: a playback rate the measured cost can keep up with
    function targetRate() {
        const cost = costP90();
        if (cost === null || dur === null) return START_RATE;
        return Math.min(speed, (dur * 1000) / ((cost + VSYNC_MS) * 1.2)) * safety;
    }

    function adaptRate(gap, jump) {
        if (!jump && gap > 0) safety = Math.max(0.05, safety * 0.7);
        else safety = Math.min(1, safety * 1.003);
        if (!playing) return;
        const want = targetRate();
        if (want < MIN_RATE) {
            if (!stepping) startStepping();
        } else if (stepping) {
            if (want > MIN_RATE * 1.6) {
                stepping = false;
                video.playbackRate = want;
                video.play();
            }
        } else {
            const rate = video.playbackRate;
            // down at once, up gently
            if (want < rate * 0.95) video.playbackRate = Math.max(MIN_RATE, want);
            else if (want > rate * 1.08) video.playbackRate = Math.min(want, rate * 1.1);
        }
    }

    // every-frame mode skipped a frame: don't deliver the later one, step to the missed frame
    // from the last delivered one, and resume at a lower rate
    function repairGap() {
        repairing = true;
        recovered++;
        safety = Math.max(0.05, safety * 0.7);
        video.pause();
        (async () => {
            const ok = await stepOnce();
            repairing = false;
            if (!ok) { playing = false; return; }
            if (!playing || stepping) return;
            const want = targetRate();
            if (want < MIN_RATE) { startStepping(); return; }
            video.playbackRate = want;
            arm();
            video.play();
        })();
    }

    function startStepping() {
        stepping = true;
        video.pause();
        (async () => {
            while (stepping && playing) {
                if (!(await stepOnce())) { stepping = false; playing = false; break; }
            }
        })();
    }

    // Seeks and resolves with what onVideoFrame reported ('ok', 'same', or the frame time while
    // probing), 'same' when no frame came soon after 'seeked', or 'timeout'.
    function seekAndWait(target) {
        return new Promise(resolve => {
            let quiet = null;
            const finish = r => {
                clearTimeout(quiet);
                clearTimeout(timeout);
                video.removeEventListener('seeked', onSeekedOnce);
                stepWaiter = null;
                resolve(r);
            };
            const onSeekedOnce = () => { quiet = setTimeout(() => finish('same'), SAME_FRAME_MS); };
            const timeout = setTimeout(() => finish('timeout'), STEP_TIMEOUT_MS);
            stepWaiter = finish;
            video.addEventListener('seeked', onSeekedOnce, { once: true });
            arm();
            ownSeek = true;
            video.currentTime = target;
        });
    }

    // Seeks to the next frame; resolves true once it has been delivered, false at the end.
    // Frames can differ in length (variable frame rate), so the seek moves on from the last
    // delivered frame in steps shorter than the shortest frame interval seen: it can't jump over
    // a short frame, and a seek that lands on the same frame is retried a little further on.
    async function stepOnce() {
        const d = dur || 1 / 30;
        const shortest = dtSamples.length ? Math.max(PROBE_STEP, Math.min(...dtSamples.filter(x => x >= MIN_FRAME), d)) : d;
        const from = last !== null ? last : video.currentTime;
        let target = from + Math.min(d, shortest) * 1.02;
        for (let attempt = 0; attempt < 12; attempt++) {
            if (Number.isFinite(video.duration) && target >= video.duration) return false;
            if ((await seekAndWait(target)) === 'ok') return true;
            target += shortest * 0.5;
        }
        return false;
    }

    // Frame duration of a file: seek forward in PROBE_STEP increments from the first frame
    // until a different frame shows. Nothing is delivered while probing.
    async function probeDuration() {
        const t0 = video.currentTime;
        probing = true;
        let found = null;
        try {
            for (let x = PROBE_STEP; x <= PROBE_MAX + 1e-9; x += PROBE_STEP) {
                if (Number.isFinite(video.duration) && t0 + x >= video.duration) break;
                const r = await seekAndWait(t0 + x);
                if (typeof r === 'number' && r > t0 + 1e-6) { found = r - t0; break; }
            }
        } finally {
            probing = false;
        }
        return found;
    }

    const onSeeking = () => { if (!ownSeek) markJump('the browser seeked'); };
    const onSeeked = () => { ownSeek = false; };
    const onEnded = () => { playing = false; stepping = false; };
    video.addEventListener('seeking', onSeeking);
    video.addEventListener('seeked', onSeeked);
    video.addEventListener('ended', onEnded);

    return {
        get playing() { return playing; },
        get mode() { return mode; },
        get time() { return video.currentTime; },
        get duration() { return video.duration; },
        async play() {
            playing = true;
            safety = 1;
            if (Number.isFinite(video.duration) && video.currentTime >= video.duration - 0.001) {
                markJump('replay from the start');
                video.currentTime = 0;
            }
            const rate = mode === 'everyFrame' ? targetRate() : speed;
            if (rate < MIN_RATE) {
                startStepping();
                return;
            }
            video.playbackRate = Math.min(rate, mode === 'everyFrame' ? START_RATE : speed);
            arm();
            await video.play();
        },
        pause() {
            playing = false;
            stepping = false;
            video.pause();
        },
        // One frame forward (pauses first). Resolves true once the frame has been delivered.
        step() {
            this.pause();
            return stepOnce();
        },
        // why: the reason the frame history restarts (shown while it refills)
        seek(time, why = 'seek') {
            markJump(why);
            video.currentTime = time;
            arm();
        },
        setMode(m) {
            mode = m;
            safety = 1;
            if (m === 'realtime') {
                if (stepping) { stepping = false; if (playing) video.play(); }
                video.playbackRate = speed;
            } else if (playing) {
                video.playbackRate = Math.max(MIN_RATE, Math.min(START_RATE, targetRate()));
            }
        },
        setSpeed(s) {
            speed = Math.max(0.25, Number(s) || 1);
            if (mode === 'realtime' && !stepping) video.playbackRate = speed;
        },
        get speed() { return speed; },
        // Called when a new source starts (video loaded and paused). Probes the frame duration
        // of a file, then delivers the first frame.
        async start({ probe = true } = {}) {
            last = null; seq = 0; markJump('start'); dur = null; probed = null; dtSamples.length = 0;
            costs.length = 0; safety = 1; dropped = 0; recovered = 0; deliveredAt.length = 0;
            playing = false; stepping = false;
            const t0 = video.currentTime;
            const d = probe ? await probeDuration() : null;
            if (d) {
                dtSamples.push(d);
                dur = probed = d;
            }
            markJump('start');
            if (d && (await seekAndWait(t0)) === 'ok') return;
            // no new frame came (probe off or failed): the one on screen was presented before
            // the loop existed, so deliver it directly
            markJump('start');
            onVideoFrame(performance.now(), { mediaTime: video.currentTime, width: video.videoWidth, height: video.videoHeight });
        },
        stats() {
            return {
                sourceFps: dur ? 1 / dur : null,
                processedFps: deliveredAt.length,
                dropped,
                recovered,
                rate: stepping ? 0 : video.playbackRate,
                stepping,
                costMs: costP90(),
            };
        },
        destroy() {
            if (handle !== null) video.cancelVideoFrameCallback(handle);
            handle = null;
            playing = false;
            stepping = false;
            video.removeEventListener('seeking', onSeeking);
            video.removeEventListener('seeked', onSeeked);
            video.removeEventListener('ended', onEnded);
        },
    };
}
