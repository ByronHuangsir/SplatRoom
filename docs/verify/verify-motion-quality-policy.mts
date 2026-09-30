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
    // one step per stepMs: the lever reallocates render targets, so a fast oscillation is not free.
    // contributionEnabled = false isolates the ladder (v2 composes the two levers — see checks 8-11)
    const q = make({ contributionEnabled: false });
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

// 8. contribution cull (v2): settled value is the engine default, and moving raises it toward the ceiling
{
    const q = make({ contributionCeiling: 1000 });
    q.update(false, 1000000, true, 70, null, 0);
    check('settled: minContribution stays at the engine base (3)', q.minContribution === 3, `minContribution=${q.minContribution}`);
    q.forceMovingGpuMs = 70;                       // over the 33 ms budget
    q.update(true, 1000000, true, 70, 70, 1000);
    check('the first engaged frame steps the contribution immediately (geometric x2)',
        Math.abs(q.minContribution - 6) < 1e-9,
        `minContribution=${q.minContribution}`);
    q.update(true, 1000000, true, 70, 70, 1000 + q.contributionStepMs + 1);
    check('further over-budget steps keep raising it (x2 per step)',
        Math.abs(q.minContribution - 12) < 1e-9,
        `minContribution=${q.minContribution}`);
    check('while the cheap lever has headroom the resolution ladder does NOT step past its first level',
        q.level === 0, `level=${q.level} scale=${q.renderScale}`);
}

// 9. the contribution ladder is rate-limited at its own cadence and clamps at the ceiling
{
    const q = make({ contributionCeiling: 24 });
    q.update(false, 1000000, true, 70, null, 0);
    q.forceMovingGpuMs = 70;
    q.update(true, 1000000, true, 70, 70, 1000);
    q.update(true, 1000000, true, 70, 70, 1000 + q.contributionStepMs + 1);
    const afterFirst = q.minContribution;
    q.update(true, 1000000, true, 70, 70, 1000 + q.contributionStepMs + 10);   // 10 ms later: refused
    check('a second contribution step within contributionStepMs is refused',
        q.minContribution === afterFirst, `${afterFirst} -> ${q.minContribution}`);
    // run to the ceiling: 3 -> 6 -> 12 -> 24
    let t = 1000 + 2 * q.contributionStepMs;
    while (t < 1000 + 2000) {
        q.update(true, 1000000, true, 70, 70, t);
        t += q.contributionStepMs + 1;
    }
    check('minContribution clamps at the ceiling', Math.abs(q.minContribution - 24) < 1e-9,
        `minContribution=${q.minContribution} atCeiling=${q.contributionAtCeiling}`);
    // only NOW may the resolution ladder step coarser (past its own 300 ms cadence)
    check('once the contribution lever is maxed the resolution ladder engages',
        q.level >= 1, `level=${q.level} scale=${q.renderScale}`);
}

// 10. inside budget the contribution relaxes toward base, and settling restores it exactly
{
    const q = make({ contributionCeiling: 1000 });
    q.update(false, 1000000, true, 70, null, 0);
    q.forceMovingGpuMs = 70;
    q.update(true, 1000000, true, 70, 70, 1000);
    let t = 1000;
    while (t < 1000 + 2000) {
        q.update(true, 1000000, true, 70, 70, t);
        t += q.contributionStepMs + 1;
    }
    const raised = q.minContribution;
    check('precondition: contribution was raised before relaxing', raised > 3, `minContribution=${raised}`);
    q.forceMovingGpuMs = 10;                       // comfortably inside the 33 ms budget
    q.update(true, 1000000, true, 70, 10, t + q.contributionStepMs + 1);
    check('an in-budget moving frame relaxes the contribution (geometric /1.4)',
        q.minContribution < raised, `${raised} -> ${q.minContribution}`);
    q.forceMovingGpuMs = null;
    const changed = q.update(false, 1000000, true, 70, null, t + 1000);
    check('settling restores minContribution to base exactly and reports the change',
        changed === true && q.minContribution === 3 && q.engaged === false,
        `changed=${changed} minContribution=${q.minContribution} engaged=${q.engaged}`);
}

// 11. the escape hatch and the tier policies
{
    const q = make({ contributionCeiling: 1000, contributionEnabled: false });
    q.update(false, 1000000, true, 70, null, 0);
    q.forceMovingGpuMs = 70;
    q.update(true, 1000000, true, 70, 70, 1000);
    q.update(true, 1000000, true, 70, 70, 1000 + q.contributionStepMs + 1);
    q.update(true, 1000000, true, 70, 70, 1000 + q.stepMs + 1);
    check('contributionEnabled = false keeps base AND lets the ladder step directly (v1 behaviour)',
        q.minContribution === 3 && q.level >= 1,
        `minContribution=${q.minContribution} level=${q.level}`);
}
{
    const q = make({ contributionCeiling: 3 });    // A-tier + high device policy: lever off
    q.update(false, 1000000, true, 70, null, 0);
    q.forceMovingGpuMs = 70;
    q.update(true, 1000000, true, 70, 70, 1000);
    q.update(true, 1000000, true, 70, 70, 1000 + q.contributionStepMs + 1);
    q.update(true, 1000000, true, 70, 70, 1000 + q.stepMs + 1);
    check('ceiling == base renders the lever inert (A/high keeps today\'s motion behaviour)',
        q.minContribution === 3 && q.level >= 1,
        `minContribution=${q.minContribution} level=${q.level}`);
}

// 12. the tier policy itself (src/core/splat-tier.ts) carries the ceiling per tier
{
    const { runtimePolicy } = await import('../../src/core/splat-tier.ts');
    const aHigh = runtimePolicy(3_000_000, { forcedClass: 'high' });
    const aLow = runtimePolicy(3_000_000, { forcedClass: 'low' });
    const b = runtimePolicy(20_000_000, {});
    const c = runtimePolicy(60_000_000, {});
    check('tier policy: A+high disables the contribution lever (ceiling 3)',
        aHigh.motionContributionCeiling === 3, `A/high ceiling=${aHigh.motionContributionCeiling}`);
    check('tier policy: A+low 800, B 1500, C 4000 (calibrated on the 20M dose-response)',
        aLow.motionContributionCeiling === 800 && b.motionContributionCeiling === 1500 && c.motionContributionCeiling === 4000,
        `A/low=${aLow.motionContributionCeiling} B=${b.motionContributionCeiling} C=${c.motionContributionCeiling}`);
}

// 13. warm start: the second gesture begins at the previous converged operating point
{
    const q = make({ contributionCeiling: 1000 });
    q.update(false, 1000000, true, 70, null, 0);
    q.forceMovingGpuMs = 70;
    q.update(true, 1000000, true, 70, 70, 1000);
    let t = 1000 + q.contributionStepMs + 1;
    while (t < 1000 + 3000) {                      // ramp and converge somewhere above base
        q.update(true, 1000000, true, 70, 70, t);
        t += q.contributionStepMs + 1;
    }
    const converged = q.minContribution;
    check('precondition: the first gesture converged above base', converged > 3, `converged=${converged}`);
    q.forceMovingGpuMs = null;
    q.update(false, 1000000, true, 70, null, t + 1000);          // settle
    check('settling restores base while remembering the operating point',
        q.minContribution === 3, `minContribution=${q.minContribution}`);
    q.forceMovingGpuMs = 70;
    const changed = q.update(true, 1000000, true, 70, 70, t + 2000);   // second gesture
    check('the second gesture warm-starts at the remembered point (no re-ramp)',
        changed === true && q.minContribution === converged,
        `changed=${changed} minContribution=${q.minContribution} (converged=${converged})`);
    // the warm frame must not immediately double (the step clock was reset)
    q.update(true, 1000000, true, 70, 70, t + 2000 + 10);
    check('the warm-start frame does not step again within the rate limit',
        q.minContribution === converged, `minContribution=${q.minContribution}`);
}

const failed = checks.filter((c) => !c.pass).length;
console.log(JSON.stringify({ checks, failed }, null, 1));
process.exit(failed === 0 ? 0 : 1);
