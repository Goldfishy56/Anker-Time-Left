// Run with: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const P = await import("../js/protocol.js");

// Vectors from SolixBLE tests/test_prime.py (captured from real Prime devices).
const VECTORS = [
  {
    id: "stage_5_response",
    packet: "ff094000030001402257ec69586f3500c8f858e0ba047f237f4e2ed8c50d2f39ba3587e4010275bea22242936f08788849272fb3f4cf7493be4a60bb9c9f0693",
    plain: "a104f079b569a30400000000a518474d54304253542c4d332e352e302f312c4d31302e352e30",
    secret: "09486817d949a232b58b47a43cc72d045a617a26f3999d30e1d27e38eae52265",
  },
  {
    id: "stage_6_response",
    packet: "ff094600030001402757ec69586f3501e8cf6185d8c4035707377af9af3a2e40b02b86e7531974f1c22440de6e43705566b77cf940e235b65abf4d413ece5f2c3781712f3742",
    plain: "a104f079b569a22437396562656433352d646339632d343930342d623430632d373263346538363361613130",
    secret: "09486817d949a232b58b47a43cc72d045a617a26f3999d30e1d27e38eae52265",
  },
  {
    id: "stage_7a_response",
    packet: "ff09230003000f420057e9b8dfdeacda7991d3eb7f12093e55ff002aa9799bcc9216e3",
    plain: "a10121fe04f079b569",
    secret: "09486817d949a232b58b47a43cc72d045a617a26f3999d30e1d27e38eae52265",
  },
  {
    id: "stage_7b_response",
    packet: "ff09530003000f420a57e9b883d958e48e5b7de48d980206577e2dafbb3d604dea3686f3011969f0db2311906d142b5730ee2bfb11e3fbbe7485aac8877995310669156ec74645c962b419e579b385fd079967",
    plain: "a10121a203044742a3250437396562656433352d646339632d343930342d623430632d373263346538363361613130a5020101fe04f079b569",
    secret: "09486817d949a232b58b47a43cc72d045a617a26f3999d30e1d27e38eae52265",
  },
];

for (const v of VECTORS) {
  test(`decrypts and re-encrypts ${v.id}`, async () => {
    const pkt = P.parsePacket(P.fromHex(v.packet));
    const secret = P.fromHex(v.secret);
    const key = secret.subarray(0, 16);
    const nonce = secret.subarray(16, 28);
    const plain = await P.gcmDecrypt(key, nonce, pkt.payload);
    assert.equal(P.hex(plain), v.plain);
    const again = await P.gcmEncrypt(key, nonce, plain);
    assert.equal(P.hex(again), P.hex(pkt.payload));
    // Our framing reproduces the original packet byte for byte.
    assert.equal(P.hex(P.buildPacket(pkt.pattern, pkt.cmd, again)), v.packet);
  });
}

test("builds the stage 7b request identically to SolixBLE", () => {
  const ts = P.fromHex("f079b569");
  const params = P.buildParams([
    ["a1", P.fromHex("21")],
    ["a2", P.fromHex("044742")],
    ["a3", new TextEncoder().encode("79ebed35-dc9c-4904-b40c-72c4e863aa10"), 4],
    ["a5", P.fromHex("0101")],
    ["fe", ts],
  ]);
  assert.equal(P.hex(params), VECTORS[3].plain);
});

test("GCM decrypt falls back to CTR when the tag is bad", async () => {
  const secret = P.fromHex(VECTORS[2].secret);
  const pkt = P.parsePacket(P.fromHex(VECTORS[2].packet));
  const broken = pkt.payload.slice();
  broken[broken.length - 1] ^= 0xff;
  const plain = await P.gcmDecrypt(secret.subarray(0, 16), secret.subarray(16, 28), broken);
  assert.equal(P.hex(plain), VECTORS[2].plain);
});

test("parses TLV params with optional 00 prefix", () => {
  const m = P.parseParams(P.fromHex("00a10121a2020155"));
  assert.equal(P.hex(m.get("a1")), "21");
  assert.equal(P.hex(m.get("a2")), "0155");
});

test("decodes A110B telemetry fields", () => {
  const params = P.buildParams([
    ["a2", P.fromHex("0157")], // 87 %
    ["a6", P.fromHex("0001c201")], // active, 45.0 W
    ["a8", P.fromHex("0001c8001900c201")], // C1 output 20.0V 2.5A 45.0W
    ["a9", P.fromHex("0000000000000000")], // C2 off
    ["ac", P.fromHex("0002320014006400")], // A input 5.0V 2.0A 10.0W
    ["af", P.fromHex("01e2")], // -30 C (signed)
  ]);
  const t = P.decodeA110B(P.parseParams(params));
  assert.equal(t.battery, 87);
  assert.equal(t.reportedOutW, 45);
  assert.deepEqual(t.ports.c1, { status: 1, volts: 20, amps: 2.5, watts: 45 });
  assert.equal(t.ports.c2.status, 0);
  assert.equal(t.ports.a.status, 2);
  assert.equal(t.temperature, -30);
});

test("rejects packets that lack port data or have impossible values", () => {
  const partial = P.parseParams(P.buildParams([["a2", P.fromHex("0157")], ["a6", P.fromHex("00000000")]]));
  assert.match(P.a110bProblem(P.decodeA110B(partial), partial), /missing a8,a9,ac/);
  const port = P.fromHex("0001c8001900c201");
  const weird = P.parseParams(P.buildParams([
    ["a2", P.fromHex("01c8")], ["a8", port], ["a9", port], ["ac", port],
  ]));
  assert.match(P.a110bProblem(P.decodeA110B(weird), weird), /battery 200/);
  const good = P.parseParams(P.buildParams([
    ["a2", P.fromHex("0140")], ["a8", port], ["a9", port], ["ac", port],
  ]));
  assert.equal(P.a110bProblem(P.decodeA110B(good), good), null);
});

// A fake power bank that speaks the device side of the handshake, to check
// the whole state machine end to end (including ECDH key agreement).
test("full negotiation against a simulated device, then telemetry", async () => {
  const subtle = globalThis.crypto.subtle;
  const devKeys = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const devPub = new Uint8Array(await subtle.exportKey("raw", devKeys.publicKey)).subarray(1);
  const staticKey = P.fromHex("b8ff7422955d4eb6d554a2c470280559");
  const staticNonce = P.fromHex("6ba3e3f2f3a60f2971ce5d1f");
  let secret = null;
  const k = () => (secret ? secret.subarray(0, 16) : staticKey);
  const n = () => (secret ? secret.subarray(16, 28) : staticNonce);

  const reply = async (pattern, cmd, params) =>
    P.buildPacket(pattern, cmd, await P.gcmEncrypt(k(), n(), P.buildParams(params)));

  const sent = [];
  const telemetry = [];
  let negotiated = false;
  let session;
  const errors = [];

  const device = async (bytes) => {
    const { pattern, cmd, payload } = P.parsePacket(bytes);
    // Strict AES-GCM (no fallback): proves both sides agree on the key.
    const aes = await subtle.importKey("raw", k(), "AES-GCM", false, ["decrypt"]);
    const plain = new Uint8Array(await subtle.decrypt(
      { name: "AES-GCM", iv: n(), additionalData: P.fromHex("3322110077665544bbaa9988ffeeddcc") }, aes, payload));
    const params = P.parseParams(plain);
    sent.push(cmd);
    const respond = (p, c, ps) => reply(p, c, ps).then((b) => session.handleNotification(b));
    switch (cmd) {
      case "4001": return respond("030001", "4801", [["a1", P.fromHex("00")]]);
      case "4003": return respond("030001", "4803", [["a2", P.fromHex("fd00")]]);
      case "4029": return respond("030001", "4829", [["a1", P.fromHex("00")]]);
      case "4005": return respond("030001", "4805", [["a1", P.fromHex("00")]]);
      case "4021": {
        const clientPub = await subtle.importKey(
          "raw", P.concat(new Uint8Array([4]), params.get("a1")),
          { name: "ECDH", namedCurve: "P-256" }, false, []);
        const shared = new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: clientPub }, devKeys.privateKey, 256));
        // Device answers under the static key, then switches to the shared one.
        const b = await reply("030001", "4821", [["a1", devPub]]);
        secret = shared;
        return session.handleNotification(b);
      }
      case "4022": return respond("030001", "4822", [["a1", P.fromHex("00")]]);
      case "4027": return respond("030001", "4827", [["a1", P.fromHex("00")]]);
      case "420a":
        return respond("03010f", "4300", [
          ["a2", P.fromHex("0142")],
          ["a6", P.fromHex("00006400")],
          ["a8", P.fromHex("0001c80005006400")],
          ["a9", P.fromHex("0000000000000000")],
          ["ac", P.fromHex("0000000000000000")],
        ]);
    }
  };

  session = new P.PrimeSession({
    write: (b) => { device(b).catch((e) => errors.push(e)); },
    onNegotiated: () => { negotiated = true; },
    onTelemetry: (p) => telemetry.push(P.decodeA110B(p)),
  });
  await session.start();
  for (let i = 0; i < 50 && !telemetry.length; i++) await new Promise((r) => setTimeout(r, 10));

  assert.deepEqual(errors, []);
  assert.deepEqual(sent, ["4001", "4003", "4029", "4005", "4021", "4022", "4027", "4200", "420a"]);
  assert.ok(negotiated);
  assert.equal(session.mtu, 253);
  assert.equal(telemetry[0].battery, 66);
  assert.equal(telemetry[0].ports.c1.watts, 10);

  // Heartbeat is an encrypted 4200 status request the device can read.
  sent.length = 0;
  await session.heartbeat();
  for (let i = 0; i < 20 && !sent.length; i++) await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(errors, []);
  assert.deepEqual(sent, ["4200"]);
});

// Real packets from an A110B (firmware as of 2026-09), captured by the app.
const REAL_0300 =
  "ff0973000301110300a10131a203045000a30404010000a4020101a50404000000a60404013b00a7080400fa0000000000a80f0400000000003800ff00ffffffff00a90f040132000b003b000007ffffffff00ac09040033000000000000af02011cb002011db103022a00fe050300000000b1";
const REAL_0A00 =
  "ff09d2000301110a0000a10131a20302ab06a303020700a403020000a5020100a603045000a70404010000a802011ca9020164aa020164ab020180ac0302dc05ad020100ae0b04a8e259cb1d8000000000af020100b0020100b1020100b20404000000b30404013b00b4080400fa0000000000b50f0400000000000000ff00ffffffff00b60f040132000b003b000007ffffffff00b909040033000000000000bc02011cbd02011dbe03022a00c00104e005047fffffffe10b04a802e259000000000000e2040401dc05fe05030000000056";

test("decodes real plain-text A110B telemetry (0300)", async () => {
  const got = [];
  const logs = [];
  const session = new P.PrimeSession({ onTelemetry: (p, cmd) => got.push([P.decodeA110B(p), cmd]), onLog: (m) => logs.push(m) });
  session.sharedSecret = new Uint8Array(32); // session established
  await session.handleNotification(P.fromHex(REAL_0300));
  assert.equal(got.length, 1);
  const [t, cmd] = got[0];
  assert.equal(cmd, "0300");
  assert.equal(t.battery, 80);
  assert.deepEqual(t.ports.c2, { status: 1, volts: 5, amps: 1.1, watts: 5.9 });
  assert.equal(t.ports.c1.status, 0);
  assert.equal(t.reportedOutW, 5.9);
  assert.equal(P.a110bProblem(t, P.parseParams(P.parsePacket(P.fromHex(REAL_0300)).payload)), null);
});

test("the 0a00 status reply is read as plain text, not as telemetry", async () => {
  const got = [];
  const logs = [];
  const session = new P.PrimeSession({ onTelemetry: (p) => got.push(p), onLog: (m) => logs.push(m) });
  session.sharedSecret = new Uint8Array(32);
  await session.handleNotification(P.fromHex(REAL_0A00));
  assert.equal(got.length, 0);
  assert.ok(logs.some((l) => l.startsWith("status reply 0a00: a1=31 a2=02ab06")), logs.join("\n"));
});

// Captured while the bank was charging at ~95 W (2026-09).
const REAL_CHARGING =
  "ff0973000301110300a10131a203040851a30404010037a4020101a5040401b603a60404000000a7080401d8002b00b603a80f0400000000003800ff00ffffffff00a90f0400000000000000ff00ffffffff00ac09040000000000000000af02011eb002011fb103022a00fe05030000000074";
const REAL_CHARGE_RAMP =
  "ff0973000301110300a10131a203040936a3040401173ba4020101a50404010000a60404000000a70804003f0000000000a80f0400000000003800ff00ffffffff00a90f0400000000000000ff00ffffffff00ac09040000000000000000af02011fb0020120b103022a00fe050300000000fa";
const REAL_0223 = "ff0919000301110223a10131a203045553a30503000000004a";

const decodeRaw = (h) => P.decodeA110B(P.parseParams(P.parsePacket(P.fromHex(h)).payload));

test("decodes charging: input total, charger port, fine battery, bank's time to full", () => {
  const t = decodeRaw(REAL_CHARGING);
  assert.equal(t.battery, 8);
  assert.equal(t.batteryFine, 8.81);
  assert.equal(t.inW, 95);
  assert.equal(t.reportedOutW, 0);
  assert.deepEqual(t.input, { status: 1, volts: 21.6, amps: 4.3, watts: 95 });
  assert.equal(t.bankMinutesToFull, 55);
});

test("ignores the bank's 23:59 placeholder while charging ramps up", () => {
  assert.equal(decodeRaw(REAL_CHARGE_RAMP).bankMinutesToFull, null);
});

test("discharging capture: output total, no input, no time to full", () => {
  const t = decodeRaw(REAL_0300);
  assert.equal(t.inW, 0);
  assert.equal(t.reportedOutW, 5.9);
  assert.equal(t.batteryFine, 80);
  assert.equal(t.bankMinutesToFull, null);
});

test("answers the bank's 0223 request with an encrypted 4a23", async () => {
  const written = [];
  const session = new P.PrimeSession({ write: (b) => written.push(b) });
  session.sharedSecret = new Uint8Array(32);
  await session.handleNotification(P.fromHex(REAL_0223));
  assert.equal(written.length, 1);
  const pkt = P.parsePacket(written[0]);
  assert.equal(pkt.pattern + "/" + pkt.cmd, "03000f/4a23");
  const plain = await P.gcmDecrypt(session.key, session.nonce, pkt.payload);
  assert.equal(P.hex(P.parseParams(plain).get("a1")), "21");
});

test("inactive input with a leftover wattage counts as 0 W (captured right after unplugging)", () => {
  // a5 = 04 00 e700: status 0 but 23.1 W still reported.
  const t = decodeRaw(
    "ff0973000301110300a10131a203040939a30404010000a4020101a5040400e700a60404000000a7080400d5000a000000a80f0400000000003800ff00ffffffff00a90f0400000000000000ff00ffffffff00ac09040000000000000000af02011fb0020120b103022a00fe050300000000df",
  );
  assert.equal(t.inW, 0);
});
