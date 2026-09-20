// Pure-node unit test for the interaction-time degradation policy (src/core/motion-quality.ts).
// No browser, no engine: the policy is a state machine over (moving, GPU spans, time), so it can be
// exercised exactly and quickly — the browser suite (verify-motion-quality.cjs) covers the wiring.
//
// usage: node --experimental-strip-types docs/verify/verify-motion-quality-policy.mts
import { MotionQuality } from '../../src/core/motion-quality.ts';

const checks: { name: string; pass: boolean; detail: string }[] = [];
const check = (name: string, pass: boolean, detail: string) => checks.push({ name, pass, detail });

const make = (overrides: Partial<MotionQuality> = {}) => {
    const q = new MotionQuality();
    Object.assign(q, overrides);
    return q;
};

// 1. engagement is decided by a SETTLED frame, not by a moving one
{
    const q = make();
    q.update(false, 1000000, true, 70, null, 0);          // settled frame costs 70 ms > engageGpuMs
    check('a slow settled frame (70 ms > 60 ms) arms degradation', q.autoEngaged === true, `autoEngaged=${q.autoEngaged}`);
    check('nothing is degraded while the camera is settled', q.engaged === false && q.renderScale === 1, `engaged=${q.engaged} scale=${q.renderScale}`);
}
{
    const q = make();
    q.update(false, 1000000, true, 20, null, 0);          // a fast machine
    const changed = q.update(true, 1000000, true, 20, 25, 1000);
    check('a fast settled frame (20 ms < 60 ms) never degrades, even while moving',
        q.autoEngaged === false && q.engaged === false && changed === false,
        `autoEngaged=${q.autoEngaged} engaged=${q.engaged} changed=${changed}`);
}

// 2. moving + armed = degraded, and the level is steered toward the budget
{
    const q = make();
    q.update(false, 1000000, true, 70, null, 0);
    q.update(true, 1000000, true, 70, 70, 1000);          // moving frame over budget (33 ms)
    check('moving over budget applies the coarsest step', q.engaged === true && q.renderScale < 1, `engaged=${q.engaged} scale=${q.renderScale} level=${q.level}`);
}
{
    // one step per stepMs: the lever reallocates render targets, so a fast oscillation is not free
    const q = make();
    Object.assign(q, { levels: [{ renderScale: 0.8, pixelSize: 0 }, { renderScale: 0.6, pixelSize: 0 }, { renderScale: 0.4, pixelSize: 0 }] });
    q.update(false, 1000000, true, 70, null, 0);
    q.update(true, 1000000, true, 70, 70, 1000);
    const levelAfterFirst = q.level;
    q.update(true, 1000000, true, 70, 70, 1010);          // 10 ms later: inside the rate limit
    check('a second step within stepMs is refused', q.level === levelAfterFirst, `level ${levelAfterFirst} -> ${q.level}`);
    q.update(true, 1000000, true, 70, 70, 1000 + q.stepMs + 1);
    check('a step after stepMs is allowed and moves toward the coarsest level', q.level === levelAfterFirst + 1, `level ${levelAfterFirst} -> ${q.level}`);
}

// 3. inside budget steps back toward full resolution, and clamps at the finest level
{
    const q = make();
    q.update(false, 1000000, true, 70, null, 0);
    q.update(true, 1000000, true, 70, 70, 1000);
    const coarse = q.level;
    q.update(true, 1000000, true, 70, 10, 1000 + q.stepMs + 1);   // 10 ms << budget
    check('a moving frame well inside budget steps finer', q.level === Math.max(0, coarse - 1), `level ${coarse} -> ${q.level}`);
    q.update(true, 1000000, true, 70, 10, 1000 + 2 * q.stepMs + 2);
    check('the finest level is never stepped past', q.level === 0, `level=${q.level}`);
}

// 4. settling always restores full resolution, whatever the level was
{
    const q = make();
    q.update(false, 1000000, true, 70, null, 0);
    q.update(true, 1000000, true, 70, 70, 1000);
    const changed = q.update(false, 1000000, true, 70, null, 2000);
    check('settling restores full resolution and reports the change',
        changed === true && q.engaged === false && q.renderScale === 1 && q.level === 0,
        `changed=${changed} engaged=${q.engaged} scale=${q.renderScale}`);
}

// 5. no timestamp-query support: engagement falls back to model size
{
    const q = make();
    q.update(true, 500000, false, null, null, 0);
    check('without timing a small model is left alone', q.engaged === false, `engaged=${q.engaged}`);
    q.update(true, 20000000, false, null, null, 1000);
    check('without timing a 20M model degrades while moving', q.engaged === true, `engaged=${q.engaged} scale=${q.renderScale}`);
}

// 6. the master switch and the test override
{
    const q = make();
    q.enabled = false;
    q.update(false, 20000000, false, null, null, 0);
    q.update(true, 20000000, false, null, null, 1000);
    check('enabled = false disables degradation entirely', q.engaged === false, `engaged=${q.engaged}`);
}
{
    const q = make();
    q.forceEngaged = true;
    q.update(true, 2000, true, 5, 5, 0);
    check('forceEngaged = true engages even on a fast small model', q.engaged === true, `engaged=${q.engaged}`);
    q.forceEngaged = false;
    q.update(true, 20000000, true, 500, 500, 1000);
    check('forceEngaged = false suppresses it even on a slow model', q.engaged === false, `engaged=${q.engaged}`);
}

// 7. reset clears everything (used when the device is restored, etc.)
{
    const q = make();
    q.update(false, 1000000, true, 70, null, 0);
    q.update(true, 1000000, true, 70, 70, 1000);
    q.reset();
    check('reset returns to full resolution and disarms',
        q.engaged === false && q.level === 0 && q.renderScale === 1 && q.autoEngaged === false,
        `engaged=${q.engaged} level=${q.level} autoEngaged=${q.autoEngaged}`);
}

const failed = checks.filter((c) => !c.pass).length;
console.log(JSON.stringify({ checks, failed }, null, 1));
process.exit(failed === 0 ? 0 : 1);
