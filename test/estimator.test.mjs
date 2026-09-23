import { test } from "node:test";
import assert from "node:assert/strict";
import { Estimator, formatDuration } from "../js/estimator.js";

// Simulated bank: true usable output Wh per % is `whPerPct`; reports rounded %.
function simulate(est, { startPct, watts, seconds, whPerPct, step = 5, inW = 0, t0 = 0 }) {
  let soc = startPct;
  let e;
  for (let t = 0; t <= seconds; t += step) {
    e = est.update(t0 + t * 1000, Math.round(soc), watts, inW);
    soc -= (watts * step) / 3600 / whPerPct;
  }
  return { e, soc };
}

test("constant 45 W load from 80 % gives ~1h05m", () => {
  const est = new Estimator();
  const e = est.update(0, 80, 45, 0);
  assert.equal(e.mode, "discharging");
  const expected = ((80 * 72.36 * 0.85) / 100 / 45) * 3600;
  assert.ok(Math.abs(e.seconds - expected) < 1, `${e.seconds} vs ${expected}`);
  assert.equal(formatDuration(e.seconds), "1:05:36");
});

test("a one-off spike barely moves the estimate", () => {
  const est = new Estimator();
  for (let t = 0; t < 180; t += 2) est.update(t * 1000, 60, 20, 0);
  const e = est.update(180000, 60, 60, 0);
  assert.ok(e.netW > 20 && e.netW < 21, `netW ${e.netW}`);
});

test("noisy phone-style load gives a steady countdown", () => {
  const est = new Estimator();
  let seed = 1;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const seen = [];
  for (let t = 0; t <= 900; t += 2) {
    // Bounces between ~3 W and ~27 W every sample, averaging 15 W.
    const e = est.update(t * 1000, 70, 3 + 24 * rand(), 0);
    if (t >= 300) seen.push(e.seconds);
  }
  const min = Math.min(...seen);
  const max = Math.max(...seen);
  assert.ok(max / min < 1.25, `range ${min.toFixed(0)}..${max.toFixed(0)} s`);
});

test("a sustained load change is followed within ~30 s", () => {
  const est = new Estimator();
  for (let t = 0; t < 180; t += 2) est.update(t * 1000, 60, 10, 0);
  let e;
  for (let t = 180; t <= 216; t += 2) e = est.update(t * 1000, 60, 60, 0);
  assert.ok(e.netW > 55, `netW ${e.netW}`);
});

test("unplugging most of the load is followed too", () => {
  const est = new Estimator();
  for (let t = 0; t < 180; t += 2) est.update(t * 1000, 60, 60, 0);
  let e;
  for (let t = 180; t <= 216; t += 2) e = est.update(t * 1000, 60, 8, 0);
  assert.ok(e.netW < 12, `netW ${e.netW}`);
});

test("countdown ticks down between samples", () => {
  const est = new Estimator();
  const e = est.update(0, 50, 30, 0);
  assert.ok(Math.abs(est.secondsAt(10000) - (e.seconds - 10)) < 1e-6);
});

test("prediction tracks a simulated discharge to empty", () => {
  const est = new Estimator();
  const whPerPct = (72.36 * 0.85) / 100;
  const watts = 30;
  const { e } = simulate(est, { startPct: 70, watts, seconds: 1800, whPerPct });
  const trueLeft = ((70 * whPerPct - (watts * 1800) / 3600) / watts) * 3600;
  assert.ok(Math.abs(e.seconds - trueLeft) < 120, `${e.seconds} vs ${trueLeft}`);
});

test("learns a bank that delivers less than rated", () => {
  const est = new Estimator();
  const trueWhPerPct = 0.5; // worse than the 0.615 prior
  simulate(est, { startPct: 90, watts: 40, seconds: 3600, whPerPct: trueWhPerPct });
  assert.ok(est.learned && est.learned.weight >= 3, "should have learned");
  assert.ok(Math.abs(est.learned.whPerPct - trueWhPerPct) < 0.03, `learned ${est.learned.whPerPct}`);
  assert.ok(est.whPerPct < 0.56, `blended ${est.whPerPct}`);
});

test("charging reports time to full", () => {
  const est = new Estimator();
  const e = est.update(0, 50, 0, 65);
  assert.equal(e.mode, "charging");
  // 40 % linear + 10 % * 1.5 taper = 55 % at 65*0.9/0.7236 %/h
  const expected = (55 / ((65 * 0.9) / 0.7236)) * 3600;
  assert.ok(Math.abs(e.seconds - expected) < 1);
});

test("idle when nothing is plugged in", () => {
  assert.equal(new Estimator().update(0, 50, 0, 0).mode, "idle");
});

test("a quick reconnect keeps the running average and the estimate", () => {
  const est = new Estimator();
  // Alternate 10 W / 30 W (average 20 W) for 3 minutes.
  for (let t = 0; t < 180; t += 2) est.update(t * 1000, 60, t % 4 ? 30 : 10, 0);
  const before = est.estimate;
  const samplesBefore = est.samples.length;
  // 45 s with no data while Bluetooth reconnects, then a 10 W reading.
  const after = est.update(225000, 60, 10, 0);
  assert.ok(est.samples.length > samplesBefore / 2, "average kept its history");
  assert.ok(Math.abs(after.netW - 20) < 1, `netW ${after.netW}`);
  // The countdown carries on from where it was, minus the elapsed time.
  const expected = before.seconds - 45;
  assert.ok(Math.abs(after.seconds - expected) / expected < 0.03, `${after.seconds} vs ${expected}`);
});

test("a very long gap starts fresh", () => {
  const est = new Estimator();
  for (let t = 0; t < 180; t += 2) est.update(t * 1000, 60, 50, 0);
  const e = est.update(600000, 55, 10, 0);
  assert.equal(e.netW, 10);
});
