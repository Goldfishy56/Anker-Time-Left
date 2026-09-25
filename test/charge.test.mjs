import { test } from "node:test";
import assert from "node:assert/strict";
import { ChargeModel, defaultShape } from "../js/charge.js";
import { Estimator } from "../js/estimator.js";

// Simulated bank: gains trueK %/Wh; accepts peakW * trueShape(pct), rounded
// to 0.01 % like the real one.
function charge(est, { from, to = 100, peakW, trueK = 0.9, trueShape, t0 = 0, onTick }) {
  let pct = from;
  let t = t0;
  while (pct < to - 1e-9) {
    const w = peakW * trueShape(pct);
    const e = est.update(t * 1000, Math.floor(pct * 100) / 100, 0, w, { precise: true });
    if (onTick) onTick(t, pct, e);
    pct = Math.min(100, pct + (trueK * w * 1) / 3600);
    t += 1;
  }
  return t;
}
// Truth: seconds to go from `pct` to 100 on the simulated bank.
function trueSeconds(pct, { peakW, trueK = 0.9, trueShape }) {
  let s = 0;
  for (let p = pct; p < 100; ) {
    const w = peakW * trueShape(p);
    p += (trueK * w) / 3600;
    s += 1;
  }
  return s;
}
// Tapers later and harder than the default guess.
const bankShape = (p) => (p < 88 ? 1 : Math.max(0.12, 1 - ((p - 88) / 12) * 0.88));

test("default taper curve", () => {
  assert.equal(defaultShape(50), 1);
  assert.equal(defaultShape(90), 0.625);
  assert.equal(defaultShape(100), 0.25);
});

test("time to full integrates the taper (default curve)", () => {
  const m = new ChargeModel(null, 1.0);
  // 50->80 at 50 W: 30/(1*50) h = 0.6 h; 80->100 slower. Must exceed linear.
  const s = m.secondsToFull(50, 50);
  const linear = (50 / 50) * 3600;
  assert.ok(s > linear * 1.3 && s < linear * 2.5, `${s} vs linear ${linear}`);
  assert.equal(m.secondsToFull(100, 50), 0);
});

test("learns this bank's taper and charge rate over one full charge", () => {
  const est = new Estimator();
  charge(est, { from: 10, peakW: 95, trueShape: bankShape });
  const m = est.charge;
  assert.ok(Math.abs(m.k - 0.9) < 0.05, `k ${m.k}`);
  assert.ok(Math.abs(m.shapeAt(60) - 1) < 0.05, `shape 60 ${m.shapeAt(60)}`);
  assert.ok(Math.abs(m.shapeAt(97.5) - bankShape(97.5)) < 0.1, `shape 97.5 ${m.shapeAt(97.5)} vs ${bankShape(97.5)}`);
});

test("after learning, the next charge's estimate matches reality", () => {
  const est = new Estimator();
  const t = charge(est, { from: 10, peakW: 95, trueShape: bankShape });
  // Unplug, then charge again from 40 % with a weaker 60 W charger.
  est.update((t + 10) * 1000, 100, 0, 0, { precise: true });
  est.update((t + 11) * 1000, 100, 0, 0, { precise: true });
  const errors = [];
  charge(est, {
    from: 40, peakW: 60, trueShape: bankShape, t0: t + 20,
    onTick: (tt, pct, e) => {
      if (tt - (t + 20) === 120 || pct > 85 && pct < 85.02 || pct > 95 && pct < 95.02) {
        const truth = trueSeconds(pct, { peakW: 60, trueShape: bankShape });
        errors.push([pct.toFixed(1), Math.round(e.seconds), truth, Math.abs(e.seconds - truth) / truth]);
      }
    },
  });
  for (const [pct, est_, truth, err] of errors) assert.ok(err < 0.1, `at ${pct}%: ${est_}s vs true ${truth}s`);
});

test("the countdown moves every second while charging (no stalls)", () => {
  const est = new Estimator();
  const secs = [];
  charge(est, {
    from: 30, to: 60, peakW: 95, trueShape: bankShape,
    onTick: (t, pct, e) => { if (t > 150) secs.push(e.seconds); },
  });
  const steps = secs.slice(1).map((v, i) => v - secs[i]);
  const stalls = steps.filter((d) => d > -0.3).length;
  assert.ok(stalls / steps.length < 0.05, `${stalls} of ${steps.length} seconds without progress`);
});

test("the bank's own minute estimate is kept for display, not used as the countdown", () => {
  const est = new Estimator();
  const e = est.update(0, 50.5, 0, 90, { precise: true, bankMinutesToFull: 54 });
  assert.equal(e.mode, "charging");
  assert.equal(e.bankSeconds, 54 * 60);
  assert.notEqual(e.seconds, 54 * 60);
});
