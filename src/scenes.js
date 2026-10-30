// Synthetic scene presets for the source picker and the tests (options for createScene).
// Target velocities are written as the camera's mean drift plus the target's own motion, so
// the targets stay in view for the whole clip.

const dot = (size, contrast, fx, fy, vx, vy, extra = {}) => ({ size, contrast, fx, fy, vx, vy, ...extra });

export const SCENES = {
    'pan-dots': {
        label: 'Pan · 2, 3 and 5 px dots',
        options: {
            width: 960, height: 540, frames: 150, camera: 'pan', seed: 21, noise: 2,
            targets: [
                dot(3, 60, 200, 150, 6 + 1.5, 2.5 + 0.8),
                dot(2, -45, 700, 400, 6 - 1.2, 2.5 - 0.6),
                dot(5, 30, 480, 270, 6 + 0.4, 2.5 - 1.5, { from: 20 }),
            ],
        },
    },
    'handheld-dots': {
        label: 'Handheld · 3 px dots',
        options: {
            width: 960, height: 540, frames: 150, camera: 'handheld', seed: 22, noise: 2.5,
            targets: [
                dot(3, 50, 150, 400, 3 + 2, -1),
                dot(3, -40, 800, 120, 3 - 1.5, 1.2, { from: 10, to: 120 }),
            ],
        },
    },
    'drone-edges': {
        label: 'Drone · hard edges, 3 px dot',
        options: {
            width: 960, height: 540, frames: 150, camera: 'drone', seed: 23, noise: 2, shapes: 60,
            targets: [dot(3, 50, 300, 300, 4 + 1.5, -1.5 + 0.8)],
        },
    },
    'static-scene': {
        label: 'Handheld · no movers (false-positive check)',
        options: { width: 960, height: 540, frames: 150, camera: 'handheld', seed: 24, noise: 2.5, shapes: 40, targets: [] },
    },
    'osd': {
        label: 'Pan · OSD overlay, 3 px dots (exclusion zones)',
        options: {
            width: 960, height: 540, frames: 150, camera: 'pan', seed: 26, noise: 2,
            // telemetry-like overlays: top-left readout, bottom bar
            osd: [{ x: 16, y: 14, w: 180, h: 28, every: 1 }, { x: 0, y: 500, w: 960, h: 40, every: 5 }],
            targets: [
                dot(3, 50, 250, 200, 6 + 1.5, 2.5 + 0.6),
                dot(3, -45, 650, 300, 6 - 1.2, 2.5 - 0.8),
            ],
        },
        // the overlays as exclusion zones (fractions of the frame), a little larger than drawn
        zones: [{ x: 12 / 960, y: 10 / 540, w: 188 / 960, h: 36 / 540 }, { x: 0, y: 496 / 540, w: 1, h: 44 / 540 }],
    },
    'exposure': {
        label: 'Pan · exposure steps, 3 px dot',
        options: {
            width: 960, height: 540, frames: 150, camera: 'pan', seed: 25, noise: 2,
            exposure: { from: 30, to: 34, gain: 32 },      // +8 grey levels a frame, like auto-exposure
            targets: [dot(3, 45, 250, 300, 6 + 1.2, 2.5 + 1)],
        },
    },
};
