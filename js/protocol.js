// Anker Prime BLE protocol: packet framing, TLV parameters, AES-GCM session
// crypto and the ECDH negotiation handshake.
//
// Ported from SolixBLE (https://github.com/flip-dots/SolixBLE, MIT licence,
// (c) 2026 Harvey Lelliott), which reverse-engineered the protocol. This file
// is transport-agnostic: hand it a `write(bytes)` function and feed it every
// notification with `handleNotification(bytes)`.

// ---------------------------------------------------------------- constants

// GATT characteristics (see SolixBLE const.py)
export const UUID_COMMAND = "8c850002-0302-41c5-b46e-cf057c562025";
export const UUID_TELEMETRY = "8c850003-0302-41c5-b46e-cf057c562025";
// Advertised by Solix/Prime devices
export const UUID_IDENTIFIER = "0000ff09-0000-1000-8000-00805f9b34fb";
// GATT service holding the two characteristics above. Not documented by
// SolixBLE, so the BLE layer also scans every service it is allowed to see.
export const UUID_SERVICE_CANDIDATES = [
  "8c850001-0302-41c5-b46e-cf057c562025",
  UUID_IDENTIFIER,
];

export const NEGOTIATION_PATTERN = "030001";
export const TELEMETRY_PATTERN_OUT = "03000f";
const SESSION_PATTERNS = new Set(["03010f", "030111"]);
const TELEMETRY_COMMANDS = new Set(["c402", "4300", "c405"]);

const NEGOTIATION_KEY = "b8ff7422955d4eb6d554a2c470280559";
const NEGOTIATION_NONCE = "6ba3e3f2f3a60f2971ce5d1f";
const AAD = "3322110077665544bbaa9988ffeeddcc";

// Fixed client key pair used for the ECDH exchange (same as SolixBLE).
const PRIVATE_KEY = "754744d72984c378bc4fa77d7fcdf6bbb6d9df119fa9be4948eb8a3b4cd6071f";
const PUBLIC_KEY =
  "d5e3020a220079c96517fd47d6023df4f5530914cc6843aaad76cf888537c4cd" +
  "7db4c879056ea7d5ff83696f0f32bd7034b251396bf0b1bb1f37a7446857d1a6";

const UUID_STRING = "79ebed35-dc9c-4904-b40c-72c4e863aa10";

// ------------------------------------------------------------------ helpers

export const hex = (bytes) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

export function fromHex(str) {
  const out = new Uint8Array(str.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(str.substr(i * 2, 2), 16);
  return out;
}

export function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const b64url = (bytes) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const utf8 = (s) => new TextEncoder().encode(s);

/** Unix timestamp, 4 bytes little-endian. */
export function timestamp(now = Date.now()) {
  const t = Math.floor(now / 1000);
  return new Uint8Array([t & 0xff, (t >>> 8) & 0xff, (t >>> 16) & 0xff, (t >>> 24) & 0xff]);
}

/** Little-endian integer from a byte slice. */
export function readInt(bytes, begin = 0, end = bytes.length, signed = false) {
  let v = 0;
  for (let i = end - 1; i >= begin; i--) v = v * 256 + bytes[i];
  const bits = (end - begin) * 8;
  if (signed && bits > 0 && v >= 2 ** (bits - 1)) v -= 2 ** bits;
  return v;
}

/** Best-effort POSIX TZ string (e.g. "STD5DST,M3.2.0,M11.1.0") for the device clock. */
export function posixTz(date = new Date()) {
  const y = date.getFullYear();
  const jan = -new Date(y, 0, 1).getTimezoneOffset();
  const jul = -new Date(y, 6, 1).getTimezoneOffset();
  const std = Math.min(jan, jul);
  const fmt = (mins) => {
    const west = -mins; // POSIX offsets are minutes *west* of UTC
    const sign = west < 0 ? "-" : "";
    const a = Math.abs(west);
    return sign + Math.floor(a / 60) + (a % 60 ? ":" + String(a % 60).padStart(2, "0") : "");
  };
  if (jan === jul) return "STD" + fmt(std);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  const rule = zone.startsWith("Europe/")
    ? ",M3.5.0/1,M10.5.0"
    : zone.startsWith("Australia/")
      ? ",M10.1.0,M4.1.0/3"
      : ",M3.2.0,M11.1.0";
  return "STD" + fmt(std) + "DST" + fmt(Math.max(jan, jul)) + rule;
}

// ---------------------------------------------------------------- framing
// <ff09> <len u16le> <pattern 3B> <cmd 2B> <payload nB> <xor checksum 1B>

export function buildPacket(pattern, cmd, payload) {
  const body = concat(
    fromHex("ff09"),
    new Uint8Array([(10 + payload.length) & 0xff, (10 + payload.length) >> 8]),
    fromHex(pattern),
    fromHex(cmd),
    payload,
  );
  return concat(body, new Uint8Array([body.reduce((a, b) => a ^ b, 0)]));
}

export function parsePacket(data) {
  if (data.length < 10 || data[0] !== 0xff || data[1] !== 0x09) {
    throw new Error("Not an Anker packet: " + hex(data));
  }
  const length = readInt(data, 2, 4);
  if (length > data.length) throw new Error(`Truncated packet (${data.length}/${length})`);
  const checksum = data.subarray(0, length - 1).reduce((a, b) => a ^ b, 0);
  if (checksum !== data[length - 1]) throw new Error("Bad checksum: " + hex(data));
  return {
    pattern: hex(data.subarray(4, 7)),
    cmd: hex(data.subarray(7, 9)),
    payload: data.slice(9, length - 1),
  };
}

// -------------------------------------------------------------- parameters
// Payload = [00 prefix]? then repeated <key 1B> <len 1B> <value lenB>

/** Encode `[[keyHex, bytes, typeByte?], ...]` into a TLV payload. */
export function buildParams(list) {
  const parts = [];
  for (const [key, value, type] of list) {
    const v = type === undefined ? value : concat(new Uint8Array([type]), value);
    parts.push(concat(new Uint8Array([parseInt(key, 16), v.length]), v));
  }
  return concat(...parts);
}

/** Decode a TLV payload into a Map of keyHex -> value bytes (type byte included). */
export function parseParams(payload) {
  const params = new Map();
  let i = payload[0] === 0x00 ? 1 : 0;
  while (i + 2 <= payload.length) {
    const key = payload[i].toString(16).padStart(2, "0");
    const len = payload[i + 1];
    if (i + 2 + len > payload.length) break;
    params.set(key, payload.slice(i + 2, i + 2 + len));
    i += 2 + len;
  }
  return params;
}

// ------------------------------------------------------------------ crypto

const subtle = () => globalThis.crypto.subtle;

async function aesKey(raw, alg) {
  return subtle().importKey("raw", raw, { name: alg }, false, ["encrypt", "decrypt"]);
}

export async function gcmEncrypt(key, nonce, plain) {
  const k = await aesKey(key, "AES-GCM");
  const out = await subtle().encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: fromHex(AAD), tagLength: 128 },
    k,
    plain,
  );
  return new Uint8Array(out); // ciphertext || 16-byte tag
}

export async function gcmDecrypt(key, nonce, data) {
  const k = await aesKey(key, "AES-GCM");
  try {
    const out = await subtle().decrypt(
      { name: "AES-GCM", iv: nonce, additionalData: fromHex(AAD), tagLength: 128 },
      k,
      data,
    );
    return new Uint8Array(out);
  } catch {
    // Tag did not verify. Like SolixBLE, decrypt anyway: GCM is CTR mode
    // starting at counter block nonce||00000002.
    const ctr = await aesKey(key, "AES-CTR");
    const counter = concat(nonce, new Uint8Array([0, 0, 0, 2]));
    const out = await subtle().decrypt(
      { name: "AES-CTR", counter, length: 32 },
      ctr,
      data.subarray(0, data.length - 16),
    );
    return new Uint8Array(out);
  }
}

export async function ecdhSharedSecret(devicePublicXY) {
  const pub = fromHex(PUBLIC_KEY);
  const priv = await subtle().importKey(
    "jwk",
    {
      kty: "EC",
      crv: "P-256",
      d: b64url(fromHex(PRIVATE_KEY)),
      x: b64url(pub.subarray(0, 32)),
      y: b64url(pub.subarray(32)),
      ext: true,
    },
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
  const devKey = await subtle().importKey(
    "raw",
    concat(new Uint8Array([0x04]), devicePublicXY),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  return new Uint8Array(await subtle().deriveBits({ name: "ECDH", public: devKey }, priv, 256));
}

// ----------------------------------------------------------------- session

/**
 * One encrypted session with a Prime device.
 *
 * Events (all optional callbacks):
 *   onStage(n)            negotiation progress, 0..7
 *   onNegotiated()        session key established, telemetry requested
 *   onTelemetry(params, cmd)  decrypted telemetry Map and its command code
 *   onLog(msg)            debug text
 */
export class PrimeSession {
  constructor({ write, onStage, onNegotiated, onTelemetry, onLog } = {}) {
    this.write = write;
    this.onStage = onStage || (() => {});
    this.onNegotiated = onNegotiated || (() => {});
    this.onTelemetry = onTelemetry || (() => {});
    this.onLog = onLog || (() => {});
    this.sharedSecret = null;
    this.negotiated = false;
    this.mtu = 253;
    this.fragments = new Map();
    this.lastPacketAt = 0;
    // Notifications may arrive faster than async crypto finishes; keep order.
    this.queue = Promise.resolve();
  }

  get key() {
    return this.sharedSecret ? this.sharedSecret.subarray(0, 16) : fromHex(NEGOTIATION_KEY);
  }

  get nonce() {
    return this.sharedSecret ? this.sharedSecret.subarray(16, 28) : fromHex(NEGOTIATION_NONCE);
  }

  async send(pattern, cmd, params) {
    const payload = await gcmEncrypt(this.key, this.nonce, buildParams(params));
    const packet = buildPacket(pattern, cmd, payload);
    this.onLog(`→ ${pattern}/${cmd} ${hex(packet)}`);
    this.lastSentAt = Date.now();
    await this.write(packet);
  }

  /** Kick off (or restart) negotiation. */
  async start() {
    this.sharedSecret = null;
    this.negotiated = false;
    this.fragments.clear();
    this.onStage(0);
    await this.send(NEGOTIATION_PATTERN, "4001", [["a1", timestamp()]]);
  }

  handleNotification(data) {
    const bytes = new Uint8Array(data.buffer ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : data);
    this.queue = this.queue
      .then(() => this.process(bytes))
      .catch((e) => this.onLog("⚠ " + (e && e.message ? e.message : e)));
    return this.queue;
  }

  reassemble(key, payload) {
    const index = payload[0] >> 4;
    const total = payload[0] & 0x0f;
    let frags = this.fragments.get(key);
    if (!frags) this.fragments.set(key, (frags = []));
    frags.push(payload.slice(1));
    if (index !== frags.length) {
      frags.length = 0;
      return null;
    }
    if (total !== frags.length) return null;
    const out = concat(...frags);
    frags.length = 0;
    return out;
  }

  async process(bytes) {
    this.lastPacketAt = Date.now();
    this.onLog(`← ${hex(bytes)}`);
    const { pattern, cmd, payload: raw } = parsePacket(bytes);
    let payload = raw;
    const fragKey = pattern + cmd;
    const fragBuf = this.fragments.get(fragKey);
    if (bytes.length === this.mtu || (fragBuf && fragBuf.length)) {
      payload = this.reassemble(fragKey, raw);
      if (!payload) return;
    }

    if (pattern === NEGOTIATION_PATTERN) {
      return this.negotiate(cmd, parseParams(await gcmDecrypt(this.key, this.nonce, payload)));
    }

    if (SESSION_PATTERNS.has(pattern) && this.sharedSecret) {
      if (cmd === "0300") return this.onTelemetry(parseParams(payload), cmd);
      const params = parseParams(await gcmDecrypt(this.key, this.nonce, payload));
      const looksLikeTelemetry = ["a2", "a6", "a8", "a9", "ac"].every((k) => params.has(k));
      if (TELEMETRY_COMMANDS.has(cmd) || looksLikeTelemetry) return this.onTelemetry(params, cmd);
      this.onLog(`unhandled ${pattern}/${cmd}: ${[...params].map(([k, v]) => k + "=" + hex(v)).join(" ")}`);
    }
  }

  async negotiate(cmd, params) {
    const ts = () => timestamp();
    switch (cmd) {
      case "4801":
        this.onStage(1);
        return this.send(NEGOTIATION_PATTERN, "4003", [
          ["a1", ts()],
          ["a3", fromHex("20")],
          ["a4", fromHex("00f0")],
        ]);
      case "4803":
        this.onStage(2);
        if (params.has("a2")) this.mtu = readInt(params.get("a2"));
        return this.send(NEGOTIATION_PATTERN, "4029", [["a1", ts()]]);
      case "4829":
        this.onStage(3);
        return this.send(NEGOTIATION_PATTERN, "4005", [
          ["a1", ts()],
          ["a3", fromHex("20")],
          ["a4", fromHex("2901")],
          ["a5", fromHex("44")],
          ["a6", fromHex("02")],
        ]);
      case "4805":
        this.onStage(4);
        return this.send(NEGOTIATION_PATTERN, "4021", [["a1", fromHex(PUBLIC_KEY)]]);
      case "4821": {
        this.onStage(5);
        this.sharedSecret = await ecdhSharedSecret(params.get("a1"));
        // Stage 5 reply is still sent under the new key, as SolixBLE does.
        return this.send(NEGOTIATION_PATTERN, "4022", [
          ["a1", ts()],
          ["a3", fromHex("00000000")],
          ["a5", utf8(posixTz())],
        ]);
      }
      case "4822":
        this.onStage(6);
        return this.send(NEGOTIATION_PATTERN, "4027", [
          ["a1", ts()],
          ["a2", utf8(UUID_STRING)],
        ]);
      case "4827":
        this.onStage(7);
        await this.requestTelemetry();
        this.negotiated = true;
        return this.onNegotiated();
      default:
        this.onLog(`unexpected negotiation cmd ${cmd}`);
    }
  }

  /**
   * Re-arm the telemetry stream. Other Prime devices stop streaming (and
   * eventually drop the link) unless this arrives every ~10 s; SolixBLE
   * sends the same command to the Prime chargers.
   */
  async keepAlive() {
    await this.send(TELEMETRY_PATTERN_OUT, "420b", [
      ["a1", fromHex("21")],
      ["fe", timestamp()],
    ]);
  }

  /** Ask the device to (keep) streaming telemetry. */
  async requestTelemetry() {
    await this.send(TELEMETRY_PATTERN_OUT, "4200", [
      ["a1", fromHex("21")],
      ["fe", timestamp()],
    ]);
    await this.send(TELEMETRY_PATTERN_OUT, "420a", [
      ["a1", fromHex("21")],
      ["a2", fromHex("044742")],
      ["a3", utf8(UUID_STRING), 4],
      ["a5", fromHex("0101")],
      ["fe", timestamp()],
    ]);
  }
}

// --------------------------------------------------------- A110B decoding

export const PortStatus = { UNKNOWN: -1, OFF: 0, OUTPUT: 1, INPUT: 2 };

function port(params, key) {
  const v = params.get(key);
  if (!v || v.length < 8) return { status: PortStatus.UNKNOWN, volts: 0, amps: 0, watts: 0 };
  return {
    status: v[1],
    volts: readInt(v, 2, 4) / 10,
    amps: readInt(v, 4, 6) / 10,
    watts: readInt(v, 6, 8) / 10,
  };
}

/**
 * Why a decoded A110B sample can't be trusted for the estimate, or null if
 * it looks sane. Other packet types reuse some of the same keys.
 */
export function a110bProblem(t, params) {
  const missing = ["a2", "a8", "a9", "ac"].filter((k) => !params.has(k));
  if (missing.length) return "missing " + missing.join(",");
  if (t.battery == null || t.battery > 100) return "battery " + t.battery;
  for (const [name, p] of Object.entries(t.ports)) {
    if (p.status < 0 || p.status > 2) return `${name} status ${p.status}`;
    if (p.volts > 50 || p.watts > 250) return `${name} ${p.volts}V ${p.watts}W`;
  }
  return null;
}

/** Decode Anker Prime Power Bank 20K 220W (A110B) telemetry. */
export function decodeA110B(params) {
  const a2 = params.get("a2");
  const a6 = params.get("a6");
  const af = params.get("af");
  return {
    battery: a2 && a2.length >= 2 ? a2[1] : null,
    reportedOutW: a6 && a6.length >= 4 ? readInt(a6, 2, 4) / 10 : null,
    temperature: af && af.length >= 2 ? readInt(af, 1, af.length, true) : null,
    ports: { c1: port(params, "a8"), c2: port(params, "a9"), a: port(params, "ac") },
  };
}
