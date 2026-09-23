import { PrimeBle, bluetoothAvailable } from "./ble.js?v=9";
import { a110bProblem, decodeA110B, hex, PortStatus } from "./protocol.js?v=9";
import { DEFAULTS, Estimator, formatDuration } from "./estimator.js?v=9";
import { APP_VERSION, CHANGELOG } from "./changelog.js?v=9";

const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------- storage

const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* private mode etc. */
    }
  },
};

let settings = { ...DEFAULTS, ...store.get("settings", {}) };
delete settings.smoothingSeconds; // old setting, replaced by averageSeconds
const estimator = new Estimator(settings, store.get("learned", null));
estimator.onLearned = (l) => {
  store.set("learned", l);
  renderLearned();
};

// ------------------------------------------------------------- logging

const logLines = [];
function log(msg) {
  const line = `${new Date().toLocaleTimeString()} ${msg}`;
  logLines.push(line);
  if (logLines.length > 3000) logLines.shift();
  if ($("debug").open) $("log").textContent = logLines.join("\n");
}
$("debug").addEventListener("toggle", () => ($("log").textContent = logLines.join("\n")));

// ------------------------------------------------------------- state

let latest = null; // last decoded telemetry
let source = null; // PrimeBle or demo
let wakeLock = null;
let connState = "disconnected";
let lastSampleAt = 0; // when the estimator last got a sample
let lastLiveAt = 0; // last moment we were connected and live
let shown = null; // countdown on screen, eased toward the estimate
let shownMode = null;
let shownAt = 0;
let finePct = false; // bank reports hundredths of a percent

function estimatorOpts() {
  return { precise: finePct, bankMinutesToFull: latest && latest.bankMinutesToFull };
}

const PORTS = [
  ["c1", "USB-C 1"],
  ["c2", "USB-C 2"],
  ["a", "USB-A"],
];

// The bank reports its own input and output totals (a5/a6); use those.
// Per-port figures are only a fallback, e.g. C1 is known to latch its last
// wattage after unplugging.
function portFlows(t) {
  if (t.inW != null && t.reportedOutW != null) return { out: t.reportedOutW, inn: t.inW };
  let out = 0;
  let inn = 0;
  for (const [key] of PORTS) {
    const p = t.ports[key];
    if (p.status === PortStatus.OUTPUT) out += p.watts;
    else if (p.status === PortStatus.INPUT) inn += p.watts;
  }
  return { out, inn };
}

function onTelemetry(params, cmd = "demo") {
  const t = decodeA110B(params);
  const problem = a110bProblem(t, params);
  if (problem) {
    return log(`ignored ${cmd} (${problem}): ${[...params].map(([k, v]) => k + "=" + hex(v)).join(" ")}`);
  }
  latest = t;
  const { out, inn } = portFlows(t);
  const p = t.ports;
  // The hundredths in a2 only count once we've seen them move off .00.
  if (t.batteryFine != null && t.batteryFine % 1 !== 0) finePct = true;
  latest.pct = finePct && t.batteryFine != null ? t.batteryFine : t.battery;
  log(
    `${cmd} ${latest.pct}% out=${out} in=${inn}` +
      (t.bankMinutesToFull != null ? ` bankFull=${t.bankMinutesToFull}m` : "") +
      ` chg=${t.input.status}/${t.input.volts}V/${t.input.watts}W` +
      ` c1=${p.c1.status}/${p.c1.watts}W c2=${p.c2.status}/${p.c2.watts}W a=${p.a.status}/${p.a.watts}W`,
  );
  estimator.update(Date.now(), latest.pct, out, inn, estimatorOpts());
  lastSampleAt = Date.now();
  latest.out = out;
  latest.inn = inn;
  renderTelemetry();
}

// ------------------------------------------------------------- rendering

const STATUS_TEXT = {
  connecting: ["Connecting…", "busy"],
  negotiating: ["Pairing…", "busy"],
  live: ["Live", "live"],
  reconnecting: ["Reconnecting…", "busy"],
  disconnected: ["Not connected", ""],
  error: ["Error", "bad"],
  demo: ["Demo", "busy"],
};

function onStatus(state, detail = "") {
  if (connState === "live") lastLiveAt = Date.now();
  connState = state;
  const [text, cls] = STATUS_TEXT[state] || [state, ""];
  const pill = $("status");
  pill.textContent = detail && state !== "error" ? `${text} ${detail}` : text;
  pill.className = "pill " + cls;
  const active = state !== "disconnected" && state !== "error";
  $("connect").classList.toggle("hidden", active);
  $("show-all").classList.toggle("hidden", active || !bluetoothAvailable());
  $("demo").classList.toggle("hidden", active);
  $("disconnect").classList.toggle("hidden", !active);
  $("nobt").classList.toggle("hidden", active || bluetoothAvailable());
  if (state === "error") {
    $("mode").textContent = "Couldn't connect";
    $("sub").textContent = detail;
  }
  if (state === "disconnected" && !latest) resetHero();
  if (active) keepAwake();
  else releaseWake();
  log(`status: ${state} ${detail}`);
}

function resetHero() {
  $("mode").textContent = "Connect your power bank";
  $("countdown").textContent = "--:--";
  $("sub").textContent = "Anker Prime 20K 220W";
  $("hero").className = "card hero";
}

function fmtW(w) {
  return w >= 100 ? w.toFixed(0) : w.toFixed(1);
}

function renderTelemetry() {
  const t = latest;
  $("pct").textContent = finePct ? t.pct.toFixed(1) : t.battery;
  $("bar").style.width = `${t.pct}%`;
  $("out").textContent = fmtW(t.out);
  $("in").textContent = fmtW(t.inn);
  $("temp").textContent = t.temperature ?? "--";
  const e = estimator.estimate;
  $("energy").textContent = e && e.remainingWh != null ? `≈ ${e.remainingWh.toFixed(1)} Wh usable` : "";

  $("ports").classList.remove("hidden");
  const rows = [...PORTS];
  if (t.input.status > 0 || t.inW > 0) rows.unshift(["input", "Charger"]);
  $("ports").innerHTML = rows.map(([key, name]) => {
    const p = key === "input" ? { ...t.input, status: PortStatus.INPUT } : t.ports[key];
    const [label, cls] =
      p.status === PortStatus.OUTPUT
        ? ["Powering a device", "out"]
        : p.status === PortStatus.INPUT
          ? ["Charging the bank", "in"]
          : p.status === PortStatus.OFF
            ? ["Nothing plugged in", ""]
            : [`Status ${p.status}`, ""];
    const active = p.status === PortStatus.OUTPUT || p.status === PortStatus.INPUT;
    return `<div class="port">
      <div><div class="name">${name}</div><div class="state ${cls}">${label}</div></div>
      <div class="nums">${
        active
          ? `<div class="w">${fmtW(p.watts)} W</div><div class="va">${p.volts.toFixed(1)} V · ${p.amps.toFixed(1)} A</div>`
          : `<div class="va">—</div>`
      }</div>
    </div>`;
  }).join("");
  renderCountdown();
}

function renderCountdown() {
  const e = estimator.estimate;
  if (!e || !latest) return;
  const hero = $("hero");
  const secs = easedSeconds(e);
  const avg = Math.abs(e.netW);
  let cls = "card hero";

  if (e.mode === "discharging") {
    $("mode").textContent = "until empty";
    $("countdown").textContent = formatDuration(secs);
    const at = new Date(Date.now() + secs * 1000);
    $("sub").textContent = `Empty around ${at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} · ${fmtW(avg)} W avg`;
    if (secs < 10 * 60) cls += " critical";
    else if (secs < 30 * 60 || latest.battery <= 15) cls += " low";
  } else if (e.mode === "charging") {
    $("mode").textContent = "until full";
    $("countdown").textContent = formatDuration(secs);
    const at = new Date(Date.now() + secs * 1000);
    $("sub").textContent =
      `Full around ${at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} · ${fmtW(avg)} W in` +
      (e.source === "bank" ? " · bank's estimate" : "");
    cls += " charging";
  } else {
    $("mode").textContent = "Nothing is drawing power";
    $("countdown").textContent = "Idle";
    $("sub").textContent = "Plug something in to see how long the bank will last";
  }
  // Brief reconnects are routine; only flag the estimate as stale after 15 s.
  const offline = connState !== "live" && connState !== "demo";
  if (offline && Date.now() - lastLiveAt > 15000) $("sub").textContent += " · last known";
  hero.className = cls;
}

// The bank only sends a reading when something changes. While connected,
// the last reading still holds, so feed it again every 2 s: that keeps the
// average weighted by time rather than by how chatty the bank was.
function holdLastReading() {
  const now = Date.now();
  if (connState !== "live" || !latest || now - lastSampleAt < 2000) return;
  estimator.update(now, latest.pct, latest.out, latest.inn, estimatorOpts());
  lastSampleAt = now;
}

// Count down one second per second and drift gently toward the estimate,
// so small revisions never show up as jumps. Big changes (new load,
// charging starts) snap straight to the new value.
function easedSeconds(e) {
  const now = Date.now();
  const target = estimator.secondsAt(now);
  const dt = (now - shownAt) / 1000;
  shownAt = now;
  if (target == null) return (shown = null);
  if (shown == null || e.mode !== shownMode || Math.abs(target - shown) > Math.max(120, target * 0.15)) {
    shownMode = e.mode;
    return (shown = target);
  }
  shown = Math.max(0, shown - dt);
  shown += (target - shown) * (1 - Math.exp(-dt / 20));
  return shown;
}

setInterval(() => {
  holdLastReading();
  renderCountdown();
}, 1000);

// ------------------------------------------------------------- wake lock

async function keepAwake() {
  if (wakeLock || !("wakeLock" in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.addEventListener("release", () => (wakeLock = null));
  } catch (e) {
    log("wake lock unavailable: " + e.message);
  }
}
function releaseWake() {
  if (wakeLock) wakeLock.release().catch(() => {});
  wakeLock = null;
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && source) keepAwake();
});

// ------------------------------------------------------------- connect

async function connect(showAll) {
  stopDemo();
  estimator.reset();
  shown = null;
  finePct = false;
  latest = null;
  const ble = new PrimeBle({ onStatus, onTelemetry, onLog: log });
  source = ble;
  try {
    await ble.choose(showAll);
  } catch (e) {
    if (e && e.name === "NotFoundError") {
      onStatus("disconnected"); // user cancelled the picker
    } else {
      onStatus("error", e && e.message ? e.message : String(e));
    }
    source = null;
  }
}

$("connect").addEventListener("click", () => {
  if (!bluetoothAvailable()) {
    $("nobt").classList.remove("hidden");
    $("nobt").scrollIntoView({ behavior: "smooth" });
    return;
  }
  connect(false);
});
$("show-all").addEventListener("click", () => connect(true));
$("disconnect").addEventListener("click", () => {
  if (source) source.disconnect();
  source = null;
});

// ------------------------------------------------------------- demo

let demoTimer = null;
function startDemo() {
  estimator.reset();
  shown = null;
  finePct = false;
  latest = null;
  let soc = 64.3;
  let t = 0;
  source = { disconnect: () => { stopDemo(); onStatus("disconnected"); } };
  onStatus("demo");
  const tick = () => {
    t += 2;
    // A laptop drawing 35-50 W, plus a phone on USB-A for the first 5 minutes.
    const laptop = 42 + 6 * Math.sin(t / 40) + (Math.random() - 0.5) * 4;
    const phone = t < 300 ? 9 + Math.random() : 0;
    soc -= ((laptop + phone) * 2) / 3600 / 0.6;
    const u16 = (v) => [v & 0xff, v >> 8];
    const port = (status, v, a, w) =>
      new Uint8Array([0, status, ...u16(Math.round(v * 10)), ...u16(Math.round(a * 10)), ...u16(Math.round(w * 10))]);
    const params = new Map([
      ["a2", new Uint8Array([0, Math.max(0, Math.round(soc))])],
      ["a6", new Uint8Array([0, 0, ...u16(Math.round((laptop + phone) * 10))])],
      ["a8", port(1, 20, laptop / 20, laptop)],
      ["a9", port(0, 0, 0, 0)],
      ["ac", phone ? port(1, 9, phone / 9, phone) : port(0, 0, 0, 0)],
      ["af", new Uint8Array([0, 31])],
    ]);
    onTelemetry(params);
  };
  tick();
  demoTimer = setInterval(tick, 2000);
}
function stopDemo() {
  clearInterval(demoTimer);
  demoTimer = null;
}
$("demo").addEventListener("click", startDemo);

// ------------------------------------------------------------- settings

function renderSettings() {
  $("cap").value = settings.capacityWh;
  $("eff").value = Math.round(settings.efficiency * 100);
  $("smooth").value = settings.averageSeconds;
  renderLearned();
}
function renderLearned() {
  const l = estimator.learned;
  const prior = estimator.priorWhPerPct;
  $("learned").textContent =
    l && l.weight
      ? `Learned from ${Math.round(l.weight)} % of real drain: ${(l.whPerPct * 100).toFixed(1)} Wh usable per full charge (rated ${(prior * 100).toFixed(1)} Wh). Using ${(estimator.whPerPct * 100).toFixed(1)} Wh.`
      : `Using ${(prior * 100).toFixed(1)} Wh usable per full charge. This gets refined automatically after the battery drops a few percent while connected.`;
}
function saveSettings() {
  const cap = parseFloat($("cap").value);
  const eff = parseFloat($("eff").value) / 100;
  const smooth = parseFloat($("smooth").value);
  if (cap > 0) settings.capacityWh = cap;
  if (eff >= 0.5 && eff <= 1) settings.efficiency = eff;
  if (smooth >= 30) settings.averageSeconds = smooth;
  store.set("settings", settings);
  Object.assign(estimator.s, settings);
  renderLearned();
}
for (const id of ["cap", "eff", "smooth"]) $(id).addEventListener("change", saveSettings);
$("reset-learned").addEventListener("click", () => {
  estimator.learned = null;
  store.set("learned", null);
  renderLearned();
});

// ------------------------------------------------------------- misc

async function copy(text, button) {
  try {
    await navigator.clipboard.writeText(text);
    const old = button.textContent;
    button.textContent = "Copied";
    setTimeout(() => (button.textContent = old), 1500);
  } catch {
    prompt("Copy this:", text);
  }
}
$("copy-url").addEventListener("click", (e) => copy(location.href, e.currentTarget));
$("copy-log").addEventListener("click", (e) => copy(logLines.join("\n"), e.currentTarget));

// ------------------------------------------------------------- change log

function renderChangelog() {
  const esc = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const date = (d) =>
    new Date(d + "T12:00:00").toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
  $("version").textContent = APP_VERSION;
  $("changelog").innerHTML = CHANGELOG.map(
    (r) => `<div class="release">
      <h3>Version ${r.version}<span>${date(r.date)}</span></h3>
      <ul>${r.changes.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>
    </div>`,
  ).join("");
  // Open it once after an update, then remember that it was seen.
  const seen = store.get("seenVersion", 0);
  if (seen < APP_VERSION) {
    $("changes").open = true;
    $("new-badge").classList.remove("hidden");
    store.set("seenVersion", APP_VERSION);
  }
}
renderChangelog();

if (!bluetoothAvailable()) {
  $("nobt").classList.remove("hidden");
  $("show-all").classList.add("hidden");
}
renderSettings();
onStatus("disconnected");
