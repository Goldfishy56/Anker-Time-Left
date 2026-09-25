// Time-to-full model that learns how this bank charges.
//
// Charging isn't linear: the bank accepts full power up to roughly 80 %,
// then draws less and less as the cells fill and warm up. Two things are
// learned from the bank's 0.01 % battery readings and saved between visits:
//
//   k      how many % the battery gains per Wh that goes in (%/Wh)
//   shape  for each 1 % band, the power accepted as a fraction of the
//          session's peak (the taper curve)
//
// Time to full = integral from now to 100 % of
//   1 / (k * W(p))   with   W(p) = W_now * shape(p) / shape(now)
// so the current wattage (which already reflects heat and the charger in
// use) is carried forward along the learned curve.

const BAND = 1; // % per shape band
const BANDS = 100 / BAND;
const RECENT_S = 120; // window for measuring the charge rate
const POWER_S = 30; // window for the current charging power
const MIN_CHARGE_W = 3;
const LEARN_AFTER_S = 90; // let the charger finish ramping up first
const BAND_MIN_READINGS = 5; // readings in a band before a pass through it counts
const STEP = 0.25; // % integration step

/** Typical Li-ion taper: full power to 80 %, easing to 25 % by 100 %. */
export function defaultShape(pct) {
  return pct < 80 ? 1 : Math.max(0.25, 1 - ((pct - 80) / 20) * 0.75);
}

export class ChargeModel {
  /**
   * @param {object|null} saved  { k, kN, shape: [{ r, s } | null] } (r = relative power, s = charges seen)
   * @param {number} defaultK    %/Wh to assume before anything is learned
   */
  constructor(saved, defaultK) {
    this.defaultK = defaultK;
    this.k = saved && saved.k > 0 ? saved.k : null;
    this.kN = (saved && saved.kN) || 0;
    this.shape = Array.from({ length: BANDS }, (_, i) => (saved && saved.shape && saved.shape[i]) || null);
    this.reset();
  }

  reset() {
    this.commitBand();
    this.band = null; // { i, sum, n } readings in the band we're passing through
    this.recent = []; // { t, pct, w } while charging
    this.sessionStart = null;
    this.sessionStartPct = null;
    this.peakW = 0;
    this.wNow = null;
  }

  toJSON() {
    return { k: this.k, kN: this.kN, shape: this.shape };
  }

  /** Learned (or default) relative power at a given %. Interpolates between bands. */
  shapeAt(pct) {
    const band = (i) => {
      const s = this.shape[i];
      return s && s.s >= 1 ? s.r : defaultShape(i * BAND + BAND / 2);
    };
    const x = Math.min(BANDS - 1, Math.max(0, pct / BAND - 0.5));
    const i = Math.floor(x);
    const j = Math.min(BANDS - 1, i + 1);
    return band(i) + (band(j) - band(i)) * (x - i);
  }

  get kUsed() {
    return this.k || this.defaultK;
  }

  /**
   * Feed a reading. Returns true when something worth saving was learned.
   * @param {number} chargeW  power going into the cells (input minus passthrough)
   * @param {boolean} precise pct has 0.01 % resolution
   */
  observe(t, pct, chargeW, precise) {
    if (pct == null || chargeW <= MIN_CHARGE_W) {
      const committed = this.commitBand();
      this.reset();
      return committed;
    }
    if (this.sessionStart == null) {
      this.sessionStart = t;
      this.sessionStartPct = pct;
    }
    this.recent.push({ t, pct, w: chargeW });
    while (this.recent.length && this.recent[0].t < t - RECENT_S * 1000) this.recent.shift();

    const lastPower = this.recent.filter((x) => x.t >= t - POWER_S * 1000);
    this.wNow = lastPower.reduce((a, x) => a + x.w, 0) / lastPower.length;

    const settled = t - this.sessionStart >= LEARN_AFTER_S * 1000;
    if (!settled || !precise) return false;
    let learned = false;

    // Charge rate from a least-squares fit of % against time.
    const span = (t - this.recent[0].t) / 1000;
    const gained = pct - this.recent[0].pct;
    if (span >= 60 && gained >= 0.05) {
      const n = this.recent.length;
      const mt = this.recent.reduce((a, x) => a + x.t, 0) / n;
      const mp = this.recent.reduce((a, x) => a + x.pct, 0) / n;
      let num = 0;
      let den = 0;
      for (const x of this.recent) {
        num += (x.t - mt) * (x.pct - mp);
        den += (x.t - mt) ** 2;
      }
      const pctPerHour = (num / den) * 3600 * 1000;
      const avgW = this.recent.reduce((a, x) => a + x.w, 0) / n;
      const kSample = pctPerHour / avgW;
      // Plausible range: 0.3-3 %/Wh (a 72 Wh bank is ~1.2 at 90 % efficiency).
      if (kSample > 0.3 && kSample < 3) {
        this.k = this.k == null ? kSample : this.k + (kSample - this.k) * 0.01;
        this.kN = Math.min(this.kN + 1, 100000);
        learned = true;
      }
    }

    // Taper curve, relative to this session's peak. Only from sessions that
    // began low enough to have seen full power first. Readings are averaged
    // over the whole pass through a band, then saved when leaving it.
    this.peakW = Math.max(this.peakW, this.wNow);
    if (this.sessionStartPct < 70 && this.peakW > 10) {
      const i = Math.min(BANDS - 1, Math.floor(pct / BAND));
      if (this.band && this.band.i !== i) learned = this.commitBand() || learned;
      if (!this.band) this.band = { i, sum: 0, n: 0 };
      this.band.sum += Math.min(1.2, this.wNow / this.peakW);
      this.band.n += 1;
    }
    return learned;
  }

  /** Fold the finished pass through a band into the saved curve. */
  commitBand() {
    const b = this.band;
    this.band = null;
    if (!b || b.n < BAND_MIN_READINGS) return false;
    const avg = b.sum / b.n;
    const cur = this.shape[b.i];
    if (!cur || !(cur.s >= 1)) this.shape[b.i] = { r: avg, s: 1 };
    else {
      cur.r += (avg - cur.r) * Math.max(0.25, 1 / (cur.s + 1));
      cur.s += 1;
    }
    return true;
  }

  /** Seconds until 100 % at the current charging power `w` (defaults to the recent average). */
  secondsToFull(pct, w = this.wNow) {
    if (pct == null || !(w > 0)) return null;
    if (pct >= 100) return 0;
    const k = this.kUsed;
    const here = this.shapeAt(pct);
    let hours = 0;
    for (let p = pct; p < 100; p += STEP) {
      const width = Math.min(STEP, 100 - p);
      const watts = Math.max(0.5, (w * this.shapeAt(p + width / 2)) / here);
      hours += width / (k * watts);
    }
    return hours * 3600;
  }
}
