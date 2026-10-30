// Counts live OpenCV.js Mats in the page: Mats made with `new cv.Mat` (also inside
// cv.matFromArray / matFromImageData), Mat.roi() headers and cv.findHomography results, minus
// those deleted. Run in the page once cv is ready: page.evaluate(instrumentMats).
export const instrumentMats = () => {
    if (window.__liveMats) return;
    const live = new Set();
    const Orig = cv.Mat;
    const track = m => { if (m && m.$$ && m.$$.ptr) live.add(m.$$.ptr); return m; };
    cv.Mat = new Proxy(Orig, { construct(target, args) { return track(new target(...args)); } });
    const del = Orig.prototype.delete;
    Orig.prototype.delete = function () { if (this.$$) live.delete(this.$$.ptr); return del.call(this); };
    // embind's overload dispatchers look themselves up by name: keep their overload table
    const wrap = (owner, name) => {
        const orig = owner[name];
        owner[name] = function (...a) { return track(orig.apply(this, a)); };
        if (orig.overloadTable) owner[name].overloadTable = orig.overloadTable;
    };
    wrap(Orig.prototype, 'roi');
    wrap(cv, 'findHomography');
    window.__liveMats = () => live.size;
};
