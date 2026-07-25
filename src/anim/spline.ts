class CubicSpline {
    // control times
    times: number[];

    // control data: in-tangent, point, out-tangent
    knots: number[];

    // dimension of the knot points
    dim: number;

    // ---- Arc-length reparameterization (for uniform-speed playback) ----
    // Flat array: [t0, s0, t1, s1, ...] where t = spline time parameter, s = cumulative arc length
    private _arcTable: number[] | null = null;
    private _totalArcLength = 0;
    // Per-segment arc lengths (i-th entry = arc length of segment from times[i] to times[i+1])
    private _segmentArcLengths: number[] | null = null;
    // Cumulative arc length at the start of each segment (same as _arcTable at segment boundaries)
    private _segmentStartArcs: number[] | null = null;

    constructor(times: number[], knots: number[]) {
        this.times = times;
        this.knots = knots;
        this.dim = knots.length / times.length / 3;
    }

    evaluate(time: number, result: number[]) {
        const { times } = this;
        const last = times.length - 1;

        if (time <= times[0]) {
            this.getKnot(0, result);
        } else if (time >= times[last]) {
            this.getKnot(last, result);
        } else {
            let seg = 0;
            while (time >= times[seg + 1]) {
                seg++;
            }
            this.evaluateSegment(seg, (time - times[seg]) / (times[seg + 1] - times[seg]), result);
        }
    }

    /**
     * Precompute arc-length lookup table so that equal arc-length increments
     * produce equal spatial displacement along the spline.
     *
     * @param samplesPerSegment Number of samples per spline segment (default 100).
     *   Higher = more accurate arc-length mapping.
     */
    buildArcLengthTable(samplesPerSegment = 100): void {
        const { times, dim } = this;
        const n = times.length;
        if (n < 2) return;

        const result = new Array<number>(dim);
        const prev = new Array<number>(dim);

        this._arcTable = [];
        this._segmentArcLengths = new Array<number>(n - 1).fill(0);
        this._segmentStartArcs = new Array<number>(n - 1).fill(0);
        this._totalArcLength = 0;

        let firstSample = true;

        const spatialDims = Math.min(3, dim);

        for (let seg = 0; seg < n - 1; seg++) {
            const t0 = times[seg];
            const t1 = times[seg + 1];
            const count = seg === n - 2 ? samplesPerSegment + 1 : samplesPerSegment;

            this._segmentStartArcs[seg] = this._totalArcLength;
            let segArcLength = 0;

            for (let i = 0; i < count; i++) {
                const localT = i / samplesPerSegment;
                const time = t0 + localT * (t1 - t0);

                this.evaluate(time, result);

                if (!firstSample) {
                    let distSq = 0;
                    for (let d = 0; d < spatialDims; d++) {
                        const diff = result[d] - prev[d];
                        distSq += diff * diff;
                    }
                    const dist = Math.sqrt(distSq);
                    this._totalArcLength += dist;
                    segArcLength += dist;
                }

                this._arcTable.push(time, this._totalArcLength);

                for (let d = 0; d < dim; d++) {
                    prev[d] = result[d];
                }
                firstSample = false;
            }

            this._segmentArcLengths[seg] = segArcLength;
        }
    }

    /**
     * Evaluate the spline at a given arc-length fraction [0, 1].
     * 0 = start of path, 1 = end of path.
     *
     * Falls back to linear time-based evaluation if arc table hasn't been built.
     */
    evaluateByArcLength(arcFraction: number, result: number[]): void {
        const { times } = this;
        const last = times.length - 1;
        const timeRange = times[last] - times[0];

        if (!this._arcTable || this._arcTable.length === 0 || this._totalArcLength < 1e-10) {
            // Fallback: linear time-based evaluation
            this.evaluate(times[0] + arcFraction * timeRange, result);
            return;
        }

        arcFraction = Math.max(0, Math.min(1, arcFraction));
        const targetS = arcFraction * this._totalArcLength;

        const tableLen = this._arcTable.length / 2;

        // Binary search for the arc-length segment containing targetS
        let lo = 0;
        let hi = tableLen - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (this._arcTable[mid * 2 + 1] <= targetS) {
                lo = mid;
            } else {
                hi = mid - 1;
            }
        }

        if (lo >= tableLen - 1) {
            this.evaluate(this._arcTable[(tableLen - 1) * 2], result);
            return;
        }

        // Linear interpolation between lo and lo+1
        const sLo = this._arcTable[lo * 2 + 1];
        const sHi = this._arcTable[(lo + 1) * 2 + 1];
        const tLo = this._arcTable[lo * 2];
        const tHi = this._arcTable[(lo + 1) * 2];

        const ds = sHi - sLo;
        const frac = ds > 1e-10 ? (targetS - sLo) / ds : 0;
        const time = tLo + frac * (tHi - tLo);

        this.evaluate(time, result);
    }

    /**
     * Whether the arc-length table has been built.
     */
    get hasArcLengthTable(): boolean {
        return this._arcTable !== null && this._arcTable.length > 0 && this._totalArcLength > 1e-10;
    }

    /**
     * Evaluate the spline at a given arc-length fraction within ONE segment.
     * Equal increments of `localFraction` within the segment produce equal spatial displacement.
     * This achieves per-segment uniform speed — speed is constant within a segment
     * but may change at keyframe boundaries.
     *
     * @param segIndex Index of the segment (0 = between times[0] and times[1])
     * @param localFraction Normalized time fraction [0, 1] within the segment
     */
    evaluateBySegmentArcLength(segIndex: number, localFraction: number, result: number[]): void {
        const { times } = this;
        const n = times.length;

        if (segIndex < 0 || segIndex >= n - 1) {
            this.evaluate(times[0], result);
            return;
        }

        if (!this._arcTable || !this._segmentArcLengths || !this._segmentStartArcs) {
            // Fallback: direct time-based evaluation
            this.evaluate(times[segIndex] + localFraction * (times[segIndex + 1] - times[segIndex]), result);
            return;
        }

        localFraction = Math.max(0, Math.min(1, localFraction));
        const segArcLen = this._segmentArcLengths[segIndex];

        if (segArcLen < 1e-10) {
            // Zero-length segment (or first segment with no samples) — use linear time
            this.evaluate(times[segIndex] + localFraction * (times[segIndex + 1] - times[segIndex]), result);
            return;
        }

        const targetS = this._segmentStartArcs[segIndex] + localFraction * segArcLen;

        // Binary search the global arc table for targetS
        const tableLen = this._arcTable.length / 2;
        let lo = 0;
        let hi = tableLen - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (this._arcTable[mid * 2 + 1] <= targetS) {
                lo = mid;
            } else {
                hi = mid - 1;
            }
        }

        if (lo >= tableLen - 1) {
            this.evaluate(this._arcTable[(tableLen - 1) * 2], result);
            return;
        }

        // Linear interpolation between lo and lo+1
        const sLo = this._arcTable[lo * 2 + 1];
        const sHi = this._arcTable[(lo + 1) * 2 + 1];
        const tLo = this._arcTable[lo * 2];
        const tHi = this._arcTable[(lo + 1) * 2];

        const ds = sHi - sLo;
        const frac = ds > 1e-10 ? (targetS - sLo) / ds : 0;
        const time = tLo + frac * (tHi - tLo);

        this.evaluate(time, result);
    }

    getKnot(index: number, result: number[]) {
        const { knots, dim } = this;
        const idx = index * 3 * dim;
        for (let i = 0; i < dim; ++i) {
            result[i] = knots[idx + i * 3 + 1];
        }
    }

    // evaluate the spline segment at the given normalized time t
    evaluateSegment(segment: number, t: number, result: number[]) {
        const { knots, dim } = this;

        const t2 = t * t;
        const twot = t + t;
        const omt = 1 - t;
        const omt2 = omt * omt;

        let idx = segment * dim * 3;                    // each knot has 3 values: tangent in, value, tangent out
        for (let i = 0; i < dim; ++i) {
            const p0 = knots[idx + 1];                  // p0
            const m0 = knots[idx + 2];                  // outgoing tangent
            const m1 = knots[idx + dim * 3];            // incoming tangent
            const p1 = knots[idx + dim * 3 + 1];        // p1
            idx += 3;

            result[i] =
                p0 * ((1 + twot) * omt2) +
                m0 * (t * omt2) +
                p1 * (t2 * (3 - twot)) +
                m1 * (t2 * (t - 1));
        }
    }

    // calculate cubic spline knots from points
    // times: time values for each control point
    // points: control point values to be interpolated (n dimensional)
    // smoothness: 0 = linear, 1 = smooth
    static calcKnots(times: number[], points: number[], smoothness: number) {
        const n = times.length;
        const dim = points.length / n;
        const knots = new Array<number>(n * dim * 3);

        for (let i = 0; i < n; i++) {
            const t = times[i];

            for (let j = 0; j < dim; j++) {
                const idx = i * dim + j;
                const p = points[idx];

                let tangent;
                if (i === 0) {
                    tangent = (points[idx + dim] - p) / (times[i + 1] - t);
                } else if (i === n - 1) {
                    tangent = (p - points[idx - dim]) / (t - times[i - 1]);
                } else {
                    tangent = (points[idx + dim] - points[idx - dim]) / (times[i + 1] - times[i - 1]);
                }

                // convert to derivatives w.r.t normalized segment parameter
                const inScale = i > 0 ? (times[i] - times[i - 1]) : (times[1] - times[0]);
                const outScale = i < n - 1 ? (times[i + 1] - times[i]) : (times[i] - times[i - 1]);

                knots[idx * 3] = tangent * inScale * smoothness;
                knots[idx * 3 + 1] = p;
                knots[idx * 3 + 2] = tangent * outScale * smoothness;
            }
        }

        return knots;
    }

    // calculate cubic spline knots with per-keyframe easing multipliers.
    // inScales[i]: tangent scaling for incoming segment at key i (0..1)
    // outScales[i]: tangent scaling for outgoing segment at key i (0..1)
    // When inScales/outScales are empty or all undefined, behaves like calcKnots with smoothness=1.
    static calcKnotsWithEasing(
        times: number[],
        points: number[],
        inScales: number[],
        outScales: number[]
    ) {
        const n = times.length;
        const dim = points.length / n;
        const knots = new Array<number>(n * dim * 3);

        for (let i = 0; i < n; i++) {
            const t = times[i];
            const inScale = inScales[i] ?? 1;
            const outScaleVal = outScales[i] ?? 1;

            for (let j = 0; j < dim; j++) {
                const idx = i * dim + j;
                const p = points[idx];

                let tangent: number;
                if (i === 0) {
                    tangent = (points[idx + dim] - p) / (times[i + 1] - t);
                } else if (i === n - 1) {
                    tangent = (p - points[idx - dim]) / (t - times[i - 1]);
                } else {
                    tangent = (points[idx + dim] - points[idx - dim]) / (times[i + 1] - times[i - 1]);
                }

                // convert to derivatives w.r.t normalized segment parameter
                const timeInScale = i > 0 ? (times[i] - times[i - 1]) : (times[1] - times[0]);
                const timeOutScale = i < n - 1 ? (times[i + 1] - times[i]) : (times[i] - times[i - 1]);

                knots[idx * 3] = tangent * timeInScale * inScale;
                knots[idx * 3 + 1] = p;
                knots[idx * 3 + 2] = tangent * timeOutScale * outScaleVal;
            }
        }

        return knots;
    }

    static fromPointsWithEasing(
        times: number[],
        points: number[],
        inScales: number[],
        outScales: number[]
    ) {
        return new CubicSpline(times, CubicSpline.calcKnotsWithEasing(times, points, inScales, outScales));
    }

    static fromPoints(times: number[], points: number[], smoothness = 1) {
        return new CubicSpline(times, CubicSpline.calcKnots(times, points, smoothness));
    }

    // create a looping spline by duplicating animation points at the end and beginning
    static fromPointsLooping(length: number, times: number[], points: number[], smoothness = 1) {
        if (times.length < 2) {
            return CubicSpline.fromPoints(times, points);
        }

        const dim = points.length / times.length;
        const newTimes = times.slice();
        const newPoints = points.slice();

        // append first two points
        newTimes.push(length + times[0], length + times[1]);
        newPoints.push(...points.slice(0, dim * 2));

        // prepend last two points
        newTimes.splice(0, 0, times[times.length - 2] - length, times[times.length - 1] - length);
        newPoints.splice(0, 0, ...points.slice(points.length - dim * 2));

        return CubicSpline.fromPoints(newTimes, newPoints, smoothness);
    }
}

export { CubicSpline };
