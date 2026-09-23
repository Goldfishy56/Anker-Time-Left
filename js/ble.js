// Web Bluetooth transport for the Prime session. Works in Chrome/Edge on
// Android and desktop, and in the Bluefy browser on iPhone.

import {
  PrimeSession,
  UUID_COMMAND,
  UUID_IDENTIFIER,
  UUID_SERVICE_CANDIDATES,
  UUID_TELEMETRY,
} from "./protocol.js?v=4";

const NEGOTIATION_RETRY_MS = 10000;
const NEGOTIATION_TIMEOUT_MS = 60000;
const RECONNECT_DELAY_MS = 3000;
const STALE_MS = 20000; // no telemetry for this long -> re-request it
const KEEP_ALIVE_MS = 9000;

export function bluetoothAvailable() {
  return typeof navigator !== "undefined" && !!navigator.bluetooth;
}

export class PrimeBle {
  /**
   * @param {object} handlers
   *   onStatus(state, detail)  state: 'connecting'|'negotiating'|'live'|'reconnecting'|'disconnected'|'error'
   *   onTelemetry(params)
   *   onLog(msg)
   */
  constructor(handlers) {
    this.h = handlers;
    this.device = null;
    this.wantConnected = false;
    this.watchdog = null;
    this.lastTelemetryAt = 0;
  }

  log(msg) {
    if (this.h.onLog) this.h.onLog(msg);
  }

  status(state, detail = "") {
    this.state = state;
    if (this.h.onStatus) this.h.onStatus(state, detail);
  }

  /** Show the browser's device picker. `showAll` lists every nearby device. */
  async choose(showAll = false) {
    const optionalServices = [...UUID_SERVICE_CANDIDATES, UUID_IDENTIFIER];
    this.device = await navigator.bluetooth.requestDevice(
      showAll
        ? { acceptAllDevices: true, optionalServices }
        : {
            filters: [{ services: [UUID_IDENTIFIER] }, { namePrefix: "Anker" }, { namePrefix: "A110" }],
            optionalServices,
          },
    );
    this.log(`Selected ${this.device.name || this.device.id}`);
    this.device.addEventListener("gattserverdisconnected", () => this.onDisconnected());
    this.wantConnected = true;
    try {
      await this.connect();
    } catch (e) {
      this.wantConnected = false;
      if (this.device.gatt.connected) this.device.gatt.disconnect();
      throw e;
    }
  }

  async findCharacteristics(server) {
    // Try the likely service first, then anything else we're allowed to see.
    let services = [];
    for (const uuid of UUID_SERVICE_CANDIDATES) {
      try {
        services.push(await server.getPrimaryService(uuid));
      } catch {
        /* not present */
      }
    }
    if (!services.length) {
      try {
        services = await server.getPrimaryServices();
      } catch (e) {
        this.log("getPrimaryServices failed: " + e.message);
      }
    }
    for (const svc of services) {
      try {
        const cmd = await svc.getCharacteristic(UUID_COMMAND);
        const tel = await svc.getCharacteristic(UUID_TELEMETRY);
        this.log(`Using service ${svc.uuid}`);
        return { cmd, tel };
      } catch {
        /* not this one */
      }
    }
    throw new Error(
      "Couldn't find the Anker data channel on this device. Make sure you picked the power bank.",
    );
  }

  async connect() {
    clearInterval(this.watchdog);
    this.status("connecting");
    const server = await this.device.gatt.connect();
    const { cmd, tel } = await this.findCharacteristics(server);

    const write = async (bytes) => {
      if (cmd.properties.writeWithoutResponse) await cmd.writeValueWithoutResponse(bytes);
      else await cmd.writeValueWithResponse(bytes);
    };

    this.session = new PrimeSession({
      write,
      onLog: (m) => this.log(m),
      onStage: (n) => this.status("negotiating", `step ${n + 1} of 8`),
      onNegotiated: () => {
        this.status("live");
        this.connectedAt = this.lastTelemetryAt = this.lastKeepAlive = Date.now();
      },
      onTelemetry: (params, cmd) => {
        this.lastTelemetryAt = Date.now();
        if (this.state !== "live") this.status("live");
        this.h.onTelemetry(params, cmd);
      },
    });

    if (this.telListener) tel.removeEventListener("characteristicvaluechanged", this.telListener);
    this.telListener = (ev) => this.session.handleNotification(ev.target.value);
    tel.addEventListener("characteristicvaluechanged", this.telListener);
    await tel.startNotifications();

    // Negotiate, restarting if the device goes quiet.
    const startedAt = Date.now();
    await this.session.start();
    this.watchdog = setInterval(() => this.tick(startedAt), 2000);
  }

  tick(startedAt) {
    const s = this.session;
    if (!s || !this.device.gatt.connected) return;
    const now = Date.now();
    if (!s.negotiated) {
      if (now - startedAt > NEGOTIATION_TIMEOUT_MS) {
        clearInterval(this.watchdog);
        this.wantConnected = false;
        this.status(
          "error",
          "The bank didn't finish the handshake. Fully close the Anker app, press the bank's button once, then try again.",
        );
        this.device.gatt.disconnect();
        return;
      }
      if (now - s.lastPacketAt > NEGOTIATION_RETRY_MS && now - (this.lastRetry || 0) > NEGOTIATION_RETRY_MS) {
        this.lastRetry = now;
        this.log("No reply, restarting handshake");
        s.start().catch((e) => this.log("restart failed: " + e.message));
      }
      return;
    }
    if (now - this.lastKeepAlive >= KEEP_ALIVE_MS) {
      this.lastKeepAlive = now;
      s.keepAlive().catch((e) => this.log("keep-alive failed: " + e.message));
    }
    if (now - this.lastTelemetryAt > STALE_MS && now - (this.lastRetry || 0) > STALE_MS) {
      this.lastRetry = now;
      this.log("Telemetry went quiet, asking again");
      s.requestTelemetry().catch((e) => this.log("request failed: " + e.message));
    }
  }

  async onDisconnected() {
    clearInterval(this.watchdog);
    if (this.connectedAt) {
      this.log(`Disconnected after ${Math.round((Date.now() - this.connectedAt) / 1000)} s live`);
      this.connectedAt = null;
    }
    if (!this.wantConnected) {
      if (this.state !== "error") this.status("disconnected");
      return;
    }
    this.status("reconnecting");
    for (let attempt = 1; this.wantConnected; attempt++) {
      await new Promise((r) => setTimeout(r, RECONNECT_DELAY_MS));
      if (!this.wantConnected) break;
      try {
        this.log(`Reconnect attempt ${attempt}`);
        await this.connect();
        return;
      } catch (e) {
        this.log("Reconnect failed: " + e.message);
        this.status("reconnecting", `attempt ${attempt}`);
      }
    }
  }

  disconnect() {
    this.wantConnected = false;
    clearInterval(this.watchdog);
    if (this.device && this.device.gatt.connected) this.device.gatt.disconnect();
    else this.status("disconnected");
  }
}
