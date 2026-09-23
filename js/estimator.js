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

export const DEFAULTS = {
  capacityWh: 72.36, // Anker Prime 20K 220W (A110B): 20,100 mAh @ 3.6 V
  efficiency: 0.85, // cell -> USB output conversion efficiency
  chargeEfficiency: 0.9, // USB input -> cell
  averageSeconds: 180, // window of the power moving average
};

const MIN_LOAD_W = 0.3; // below this the bank is effectively idle
const LEARN_MIN_DROP = 3; // % drop needed before trusting a measured Wh/%
const MAX_GAP_S = 30; // longer telemetry gaps reset integration
// A new load is adopted early only if every sample for this long sits on the
// same side of the running average, by a clear margin (plug/unplug, not noise).
const SHIFT_SECONDS = 30;
const SHIFT_MIN_W = 3;
const SHIFT_RATIO = 0.35;

export class Estimator {
  constructor(settings = {}, learned = null) {
    this.s = { ...DEFAULTS, ...settings };
    // Learned usable output Wh per battery percent: { whPerPct, weight }
    this.learned = learned;
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
   * @returns estimate object (see below)
   */
  update(t, pct, outW, inW) {
    const net = outW - inW;
    const dt = this.lastT == null ? 0 : (t - this.lastT) / 1000;
    const gap = dt > MAX_GAP_S;

    this.netW = this.average(t, net, gap);
    this.instantNetW = net;

    // Interpolate state of charge between whole-percent readings.
    const whPerPct = this.whPerPct;
    if (this.soc == null || gap || pct == null) {
      this.soc = pct;
    } else if (pct !== this.pct) {
      // Just crossed a boundary: assume the bank rounds, so we sit at x.5.
      this.soc = pct < this.pct ? pct + 0.5 : pct - 0.5;
    } else if (dt > 0) {
      const wh = (this.instantNetW * dt) / 3600;
      const cellPctPerWh = net >= 0 ? 1 / whPerPct : this.s.chargeEfficiency / (this.s.capacityWh / 100);
      this.soc -= wh * cellPctPerWh;
    }
    if (pct != null) this.soc = Math.min(100, Math.max(pct - 0.5, Math.min(pct + 0.99, this.soc)));

    this.learn(pct, outW, inW, dt, gap);

    this.lastT = t;
    this.pct = pct;
    this.estimate = this.compute(t);
    return this.estimate;
  }

  // Moving average of net power over `averageSeconds`. Noisy loads (phones
  // renegotiating, laptops idling) average out; a sustained change in load
  // restarts the window so the estimate still follows it within ~30 s.
  average(t, net, gap) {
    if (gap) this.samples = [];
    this.samples.push({ t, net });
    const windowStart = t - this.s.averageSeconds * 1000;
    while (this.samples.length > 1 && this.samples[0].t < windowStart) this.samples.shift();

    const mean = (list) => list.reduce((a, x) => a + x.net, 0) / list.length;
    const long = mean(this.samples);
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
    if (pct == null || inW > 0.5 || gap) {
      this.anchor = null;
      return;
    }
    if (this.anchor) {
      if (pct > this.anchor.pct) this.anchor = null;
      else this.deliveredWh += (outW * dt) / 3600;
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
      // Charging: roughly linear to ~90 %, then the CV phase tapers. Pad the
      // last 10 % by 1.5x to account for that.
      const cellWhPerPct = this.s.capacityWh / 100;
      const rate = (-netW * this.s.chargeEfficiency) / cellWhPerPct; // %/h
      const linear = Math.max(0, 90 - soc);
      const taper = Math.max(0, 100 - Math.max(soc, 90)) * 1.5;
      return { mode: "charging", seconds: ((linear + taper) / rate) * 3600, at: t, soc, remainingWh, netW };
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
