// Turns a stream of telemetry samples (battery %, watts in/out) into a
// smoothed "time until empty" / "time until full" estimate.
//
// Model:
//   usable Wh per 1 %  = capacityWh * efficiency / 100   (prior)
//   refined over time by measuring Wh actually delivered per % dropped.
//   remaining Wh       = socEstimate * whPerPercent
//   time left          = remaining Wh / average net watts over the last few minutes
//
// The bank only reports whole percents, so between ticks the state of charge
// is interpolated by integrating the measured power draw.

import { ChargeModel } from "./charge.js?v=12";

export const DEFAULTS = {
  capacityWh: 72.36, // Anker Prime 20K 220W (A110B): 20,100 mAh @ 3.6 V
  efficiency: 0.85, // cell -> USB output conversion efficiency
  chargeEfficiency: 0.9, // USB input -> cell
  averageSeconds: 180, // window of the power moving average
};

const MIN_LOAD_W = 0.3; // below this the bank is effectively idle
const LEARN_MIN_DROP = 3; // % drop needed before trusting a measured Wh/%
// Short gaps (e.g. a Bluetooth reconnect) are bridged using the average
// power; only a gap longer than the averaging window starts from scratch.
const LEARN_MAX_GAP_S = 120;
// A new load is adopted early only if every sample for this long sits on the
// same side of the running average, by a clear margin (plug/unplug, not noise).
const SHIFT_SECONDS = 30;
const SHIFT_MIN_W = 3;
const SHIFT_RATIO = 0.35;
const FLIP_MIN_W = 3; // charging below this net input is treated as not charging

export class Estimator {
  constructor(settings = {}, learned = null, chargeSaved = null) {
    this.s = { ...DEFAULTS, ...settings };
    // Learned usable output Wh per battery percent: { whPerPct, weight }
    this.learned = learned;
    // Learned charging behaviour (rate per Wh and taper curve).
    this.charge = new ChargeModel(chargeSaved, this.s.chargeEfficiency / (this.s.capacityWh / 100));
    this.lastChargeSave = 0;
    this.reset();
  }

  reset() {
    this.lastT = null;
    this.pct = null;
    this.soc = null; // interpolated state of charge, %
    this.netW = null; // averaged net power: + discharging, - charging
    this.samples = []; // recent { t, net } for the moving average
    this.instantNetW = 0;
    this.anchor = null; // { pct } % boundary where the learning window began
    this.deliveredWh = 0; // output energy since anchor
    this.estimate = null;
    if (this.charge) this.charge.reset();
  }

  get priorWhPerPct() {
    return (this.s.capacityWh * this.s.efficiency) / 100;
  }

  get whPerPct() {
    const prior = this.priorWhPerPct;
    if (!this.learned || !this.learned.weight) return prior;
    // Blend: the prior counts as 5 % worth of evidence.
    const w = this.learned.weight;
    return (prior * 5 + this.learned.whPerPct * w) / (5 + w);
  }

  /**
   * Feed one sample.
   * @param {number} t      time in ms
   * @param {number} pct    battery percent (integer)
   * @param {number} outW   watts leaving the bank
   * @param {number} inW    watts entering the bank
   * @param {object} [opts]
   *   precise: pct has real sub-percent resolution (use it as-is)
   *   bankMinutesToFull: the bank's own time-to-full, used while charging
   * @returns estimate object (see below)
   */
  update(t, pct, outW, inW, opts = {}) {
    this.precise = !!opts.precise;
    this.bankMinutesToFull = opts.bankMinutesToFull ?? null;
    const net = outW - inW;
    const dt = this.lastT == null ? 0 : (t - this.lastT) / 1000;
    const gap = dt > this.s.averageSeconds;

    this.netW = this.average(t, net, gap);
    this.instantNetW = net;

    // Interpolate state of charge between whole-percent readings.
    const whPerPct = this.whPerPct;
    if (this.precise || this.soc == null || gap || pct == null) {
      this.soc = pct;
    } else if (pct !== this.pct) {
      // Just crossed a boundary: assume the bank rounds, so we sit at x.5.
      this.soc = pct < this.pct ? pct + 0.5 : pct - 0.5;
    } else if (dt > 0) {
      // Over a longer gap (reconnect) the average is a better guess than the
      // latest reading.
      const w = dt > 10 ? this.netW : this.instantNetW;
      const wh = (w * dt) / 3600;
      const cellPctPerWh = w >= 0 ? 1 / whPerPct : this.s.chargeEfficiency / (this.s.capacityWh / 100);
      this.soc -= wh * cellPctPerWh;
    }
    if (pct != null && !this.precise) {
      this.soc = Math.min(100, Math.max(pct - 0.5, Math.min(pct + 0.99, this.soc)));
    }

    this.learn(pct, outW, inW, dt, gap);
    const chargeLearned = this.charge.observe(t, pct, inW - outW, this.precise);
    // Save at most every 30 s while charging, and always when a charge ends.
    if (chargeLearned && (t - this.lastChargeSave > 30000 || this.charge.sessionStart == null)) {
      this.lastChargeSave = t;
      if (this.onChargeLearned) this.onChargeLearned(this.charge.toJSON());
    }

    this.lastT = t;
    this.pct = pct;
    this.estimate = this.compute(t);
    return this.estimate;
  }

  // Moving average of net power over `averageSeconds`. Noisy loads (phones
  // renegotiating, laptops idling) average out; a sustained change in load
  // restarts the window so the estimate still follows it within ~30 s.
  average(t, net, gap) {
    if (gap) this.samples = []; // older than the whole window anyway
    this.samples.push({ t, net });
    const windowStart = t - this.s.averageSeconds * 1000;
    while (this.samples.length > 1 && this.samples[0].t < windowStart) this.samples.shift();

    const mean = (list) => list.reduce((a, x) => a + x.net, 0) / list.length;
    const long = mean(this.samples);

    // Charging starting or stopping flips the direction of power: follow it
    // immediately (after two readings agree) rather than waiting out the
    // window, or "until full" lingers after the charger is removed.
    const charging = (w) => w < -FLIP_MIN_W;
    const before = this.samples.slice(0, -1);
    if (before.length && charging(mean(before)) !== charging(net)) {
      this.flipCount = (this.flipCount || 0) + 1;
      if (this.flipCount >= 2) {
        this.flipCount = 0;
        this.samples = this.samples.slice(-2);
        return mean(this.samples);
      }
    } else {
      this.flipCount = 0;
    }
    const recent = this.samples.filter((x) => x.t >= t - SHIFT_SECONDS * 1000);
    const older = this.samples.length - recent.length;
    if (older > 0 && recent.length >= 3 && t - recent[0].t >= SHIFT_SECONDS * 0.8) {
      const base = mean(this.samples.slice(0, older));
      const margin = Math.max(SHIFT_MIN_W, Math.abs(base) * SHIFT_RATIO);
      const allAbove = recent.every((x) => x.net > base + margin);
      const allBelow = recent.every((x) => x.net < base - margin);
      if (allAbove || allBelow) {
        this.samples = recent;
        return mean(recent);
      }
    }
    return long;
  }

  // Measure how many output Wh the bank really delivers per 1 % it drops,
  // between two whole-percent boundaries, while not charging.
  learn(pct, outW, inW, dt, gap) {
    if (pct == null || inW > 0.5 || gap || dt > LEARN_MAX_GAP_S) {
      this.anchor = null;
      return;
    }
    if (this.anchor) {
      if (pct > this.anchor.pct) this.anchor = null;
      else this.deliveredWh += (outW * dt) / 3600;
    }
    if (this.precise && !this.anchor) {
      // Fine-grained %: measure from any point, no need to wait for a boundary.
      this.anchor = { pct };
      this.deliveredWh = 0;
      return;
    }
    if (this.pct == null || pct >= this.pct) return;

    // Just crossed a % boundary.
    if (this.anchor) {
      const drop = this.anchor.pct - pct;
      if (drop < LEARN_MIN_DROP) return;
      const sample = this.deliveredWh / drop;
      const prior = this.priorWhPerPct;
      // Ignore wildly implausible samples (bad telemetry).
      if (sample > prior * 0.5 && sample < prior * 1.5) {
        const l = this.learned || { whPerPct: sample, weight: 0 };
        l.whPerPct = (l.whPerPct * l.weight + sample * drop) / (l.weight + drop);
        l.weight = Math.min(l.weight + drop, 60);
        this.learned = l;
        if (this.onLearned) this.onLearned(l);
      }
    }
    this.anchor = { pct };
    this.deliveredWh = 0;
  }

  /**
   * @returns {{mode: 'discharging'|'charging'|'idle'|'unknown', seconds: number|null,
   *   at: number, soc: number|null, remainingWh: number|null, netW: number}}
   */
  compute(t) {
    const soc = this.soc;
    const netW = this.netW ?? 0;
    if (soc == null) return { mode: "unknown", seconds: null, at: t, soc, remainingWh: null, netW };
    const remainingWh = soc * this.whPerPct;
    if (netW > MIN_LOAD_W) {
      return { mode: "discharging", seconds: (remainingWh / netW) * 3600, at: t, soc, remainingWh, netW };
    }
    if (netW < -MIN_LOAD_W) {
      // Learned charge model: current charging power carried along the
      // learned taper curve (see charge.js).
      const seconds = this.charge.secondsToFull(soc, this.charge.wNow ?? -netW);
      const bankSeconds = this.bankMinutesToFull ? this.bankMinutesToFull * 60 : null;
      return { mode: "charging", seconds, at: t, soc, remainingWh, netW, bankSeconds };
    }
    return { mode: "idle", seconds: null, at: t, soc, remainingWh, netW };
  }

  /** Estimate as of time `t`, counting down smoothly between samples. */
  secondsAt(t) {
    const e = this.estimate;
    if (!e || e.seconds == null) return null;
    return Math.max(0, e.seconds - (t - e.at) / 1000);
  }
}

export function formatDuration(seconds, withSeconds = true) {
  if (seconds == null || !isFinite(seconds)) return "--:--";
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h >= 100) return `${Math.floor(h / 24)}d ${h % 24}h`;
  return withSeconds
    ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
    : `${h}h ${String(m).padStart(2, "0")}m`;
}
