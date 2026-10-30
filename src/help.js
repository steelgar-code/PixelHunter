// Plain-language explanations shown under each setting (the "?" next to it). Pure data.
// "px" is pixels at the processing width.

export const HELP = {
    mode: 'Real-time plays at normal speed and skips frames it can\'t keep up with (counted as Dropped): for watching. Every frame never skips: it slows playback down, or steps frame by frame. Use it when testing settings, so two runs give the same result.',
    view: 'Display only, doesn\'t change detection. Original: the video. Stabilised: the previous frame lined up onto this one, 50/50; sharp = good alignment, double edges = camera motion is off. Points: points used for camera motion (green used, red rejected, grey lost). Raw diff: what\'s left after lining up, ×4; movers glow, the background should be black. Mask: pixels that passed the diff threshold, the raw material for candidates.',
    showCandidates: 'Faint yellow boxes around everything that differed this frame, before confirmation. Turn off to see only confirmed detections (magenta).',
    showTruth: 'Test scenes only: dashed circles where the targets really are, to compare with what was found.',
    showZones: 'Show the inclusion (green, outside dimmed) and exclusion (red, hatched) zones on the video.',

    detectMode: 'Robust compares frame t with the frame before and the frame after, and keeps only what differs from both: no "ghost" where the object just was, far fewer false alarms at edges. Basic compares with the previous frame only; keep it for comparison.',
    procWidth: 'Shrinks the video before searching it. Smaller is faster, but objects shrink too. Example: on 1920 px video a 3 px drone becomes 1 px at 640, about the limit. Hunting tiny things: keep Source. All pixel sizes below are at this width.',
    stride: 'How many frames apart the comparison is. An object only shows if it moves at least its own size + 2 px between the compared frames, so slow movers need a bigger stride: stride ≥ (size + 2) ÷ speed. Example: a 3 px bird at 1 px/frame is invisible at stride 1, found at stride 5. Costs: results lag that many frames; fast objects gain nothing.',
    threshold: 'How much brighter or darker than its surroundings something must be (grey levels, 0–255). Example: a dark bird on pale sky differs by ~60, easy at 20; a grey drone on grey cloud by ~15, needs ~12. Lower = fainter things and more noise. Judge with the Raw diff view.',
    minArea: 'Smallest spot kept, in px. 1 keeps single pixels. Use 4–9 when targets are bigger and you want to ignore specks of noise.',
    maxArea: 'Largest spot kept, in px. 400 ≈ 20×20 px. Example: a nearby bird filling 40×30 px is thrown away at 400: raise to 2000+.',
    borderMargin: 'Ignores a strip this wide at the frame edge, where the lined-up frames don\'t fully overlap. Raise it if false detections line up along the edges.',
    brightness: 'Cancels automatic exposure changes, e.g. the camera brightening as it turns away from the sun. Leave on.',
    blur: 'Smooths the picture first: less noise and compression blockiness, but 1–2 px objects get erased. Only for bigger targets.',
    open: 'Deletes every spot only 1–2 px wide. Same trade-off as the blur, stronger.',
    zonesMotion: 'Points inside exclusion zones aren\'t used to work out camera motion: an overlay that never moves on screen would make the camera look still. Leave on.',

    confirmN: 'A candidate becomes a confirmed detection (magenta box, #id) once seen in N of the last M frames. Example: found in frames 1, 2 and 4 = 3 of 5, confirmed. Higher N = fewer false alarms, slower confirmation.',
    confirmM: 'The window for "seen in N of the last M frames". Higher M forgives more missed frames, e.g. an object blinking through compression or passing behind a branch, or one that moves in short jerks (try 3 of 8). Too high lets scattered noise confirm.',
    gateBase: 'How far from where it was expected an object may appear and still count as the same one, in px. Example: a zig-zagging insect needs more. Too big and random noise joins tracks.',
    maxSpeed: 'Fastest an object may move when first spotted, px per frame. Example: a car crossing 1920 px in 2 s at 25 fps moves ~38 px/frame; at the default 12 it never confirms: set ~40.',
    holdFrames: 'Objects that stop now and then (a bird landing, a drone hovering) vanish while still: only movement is detected. A confirmed track missed for more than M frames is kept this long (dashed box at its last position). When the object moves again near there it gets its old id back, after confirming afresh. At 25 fps, 50 frames = 2 s. 0 = forget at once.',
    minTravel: 'An object must move at least this far from where it was first seen before it confirms. Rejects things that flicker in place (leaf edges, shimmering roofs). Slow objects confirm later: at 0.5 px/frame and 3 px, about 6 frames.',

    estWidth: 'Resolution used to work out camera motion. Higher = more precise, slower. Raise it if the Stabilised view shows slight double edges.',
    features: 'How many points are tracked to work out camera motion. More = more reliable on cluttered or partly blocked views, slower.',
    lkWin: 'Size of the patch followed around each point, px. Bigger follows faster camera moves and blur, a little less precisely. Raise for whip-pans or shaky handheld video (Skipped count climbing).',
    lkLevels: 'Coarse-to-fine levels for following points: each level doubles how big a jump between frames can be followed. Raise together with the LK window for fast pans.',
    fbMax: 'Each point is tracked forward and back again; if it doesn\'t return within this many px it is distrusted. Lower = stricter.',
    reseedBelow: 'When fewer tracked points than this survive, start over with fresh points across the whole frame.',
    ransacPx: 'How far a point may be from the agreed camera motion and still count, px at the estimation width. Raise slightly for scenes with depth (near trees, far hills move differently) or wide-angle lens bending.',
    minInliers: 'If fewer points than this agree on the camera motion, the frame is skipped instead of guessed (counted under Skipped). Example: over water, featureless sky.',
    minInlierRatio: 'If less than this share of points agree, the frame is skipped. Example: a big truck filling half the frame moves differently from the background. Lower = accepts shakier fits.',

    hJitter: 'Test aid: deliberately misaligns frames by up to this much, to see how detection copes. Not saved.',
    simLoad: 'Test aid: makes each frame artificially slow, to test how real-time mode drops frames. Not saved.',
};

export const SECTION_HELP = {
    presets: 'One click sets detection, confirmation and camera motion as a starting point to tune from. Highest: faint 1–2 px specks moving slowly (a distant drone on grey sky). Mid: the defaults, birds or small drones 3–10 px with clear contrast. Low: big, obvious, fast things only (cars from a drone, a person running); fastest, fewest false alarms, ignores small specks. Change anything by hand and it shows Custom. My presets: save the current settings, zones, or both under a name (e.g. "DJI OSD" with just the exclusion zones for that drone\'s overlay, or "faint + sky only" with both); Apply puts them back, leaving out what the preset doesn\'t hold. Saved in this browser; Export / Import moves them to another. #preset=<name> in the address applies one on opening.',
    area: 'Include (crop): look only here, e.g. just the sky above the treeline; detection gets faster in proportion (a quarter of the frame ≈ 4× quicker). Camera motion still uses the whole frame. Exclude: never look here, e.g. telemetry text, a timestamp, a logo, propeller tips in view; draw zones a little bigger than the overlay. Pick a kind, then drag on the video. Exclusion zones also apply inside inclusion zones.',
};
