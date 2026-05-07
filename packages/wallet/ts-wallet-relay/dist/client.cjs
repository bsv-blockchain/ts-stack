"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client.ts
var client_exports = {};
__export(client_exports, {
  DEFAULT_ACCEPTED_SCHEMAS: () => DEFAULT_ACCEPTED_SCHEMAS,
  DEFAULT_AUTO_APPROVE_METHODS: () => DEFAULT_AUTO_APPROVE_METHODS,
  DEFAULT_IMPLEMENTED_METHODS: () => DEFAULT_IMPLEMENTED_METHODS,
  PROTOCOL_ID: () => PROTOCOL_ID,
  WALLET_METHOD_NAMES: () => WALLET_METHOD_NAMES,
  WalletPairingSession: () => WalletPairingSession,
  WalletRelayClient: () => WalletRelayClient,
  WalletRelayError: () => WalletRelayError,
  base64urlToBytes: () => base64urlToBytes,
  bytesToBase64url: () => bytesToBase64url,
  decryptEnvelope: () => decryptEnvelope,
  encryptEnvelope: () => encryptEnvelope,
  parsePairingUri: () => parsePairingUri,
  verifyPairingSignature: () => verifyPairingSignature
});
module.exports = __toCommonJS(client_exports);

// src/shared/encoding.ts
var import_sdk = require("@bsv/sdk");
function bytesToBase64url(bytes) {
  return import_sdk.Utils.toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}
function base64urlToBytes(str) {
  return import_sdk.Utils.toArray(str.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

// src/shared/crypto.ts
async function encryptEnvelope(wallet, params, payload) {
  const plaintext = Array.from(new TextEncoder().encode(payload));
  const { ciphertext } = await wallet.encrypt({
    protocolID: params.protocolID,
    keyID: params.keyID,
    counterparty: params.counterparty,
    plaintext
  });
  return bytesToBase64url(ciphertext);
}
async function decryptEnvelope(wallet, params, ciphertextB64) {
  const ciphertext = base64urlToBytes(ciphertextB64);
  const { plaintext } = await wallet.decrypt({
    protocolID: params.protocolID,
    keyID: params.keyID,
    counterparty: params.counterparty,
    ciphertext
  });
  return new TextDecoder().decode(new Uint8Array(plaintext));
}

// src/client/WalletPairingSession.ts
var DEFAULT_IMPLEMENTED_METHODS = /* @__PURE__ */ new Set([
  "getPublicKey",
  "listOutputs",
  "createAction",
  "signAction",
  "createSignature",
  "verifySignature",
  "listActions",
  "internalizeAction",
  "acquireCertificate",
  "relinquishCertificate",
  "listCertificates",
  "revealCounterpartyKeyLinkage",
  "createHmac",
  "verifyHmac",
  "encrypt",
  "decrypt"
]);
var DEFAULT_AUTO_APPROVE_METHODS = /* @__PURE__ */ new Set(["getPublicKey"]);
var WalletPairingSession = class {
  constructor(wallet, params, options = {}) {
    this.wallet = wallet;
    this.params = params;
    this.options = options;
    this.ws = null;
    this._status = "idle";
    this.connected = false;
    this._lastSeq = 0;
    this._resolvedRelay = null;
    this.mobileIdentityKey = null;
    this.requestHandler = null;
    this.listeners = { connected: [], disconnected: [], error: [] };
    this.protocolID = JSON.parse(params.protocolID);
    this.implementedMethods = options.implementedMethods ?? DEFAULT_IMPLEMENTED_METHODS;
    this.autoApproveMethods = options.autoApproveMethods ?? DEFAULT_AUTO_APPROVE_METHODS;
  }
  get status() {
    return this._status;
  }
  /**
   * The highest seq value received from the backend in this connection.
   * Persist this before disconnecting so you can pass it to `reconnect(lastSeq)`.
   *
   * ```ts
   * session.on('disconnected', () => {
   *   SecureStore.setItemAsync('lastseq_' + topic, String(session.lastSeq))
   * })
   * ```
   */
  get lastSeq() {
    return this._lastSeq;
  }
  on(event, handler) {
    const bucket = this.listeners[event];
    if (bucket) bucket.push(handler);
    return this;
  }
  /** Register the handler that executes approved RPC methods. */
  onRequest(handler) {
    this.requestHandler = handler;
    return this;
  }
  // ── Lifecycle ────────────────────────────────────────────────────────────────
  /**
   * Fetch the relay WebSocket URL from the origin server.
   *
   * Must be called before `connect()`. Returns the relay URL so the app can
   * display it to the user for approval before proceeding.
   *
   * The fetch goes to `params.origin` over HTTPS — the origin's TLS certificate
   * is the trust anchor. Always show `params.origin` to the user before calling
   * this method so they can confirm they are connecting to the intended service.
   *
   * ```ts
   * const { params } = parsePairingUri(qrString)
   * // Show params.origin to the user and wait for approval, then:
   * const relay = await session.resolveRelay()
   * // Optionally show relay to the user, then:
   * await session.connect()
   * ```
   */
  async resolveRelay() {
    const res = await fetch(`${this.params.origin}/api/session/${this.params.topic}`);
    if (!res.ok) throw new Error(`Failed to resolve relay from origin: HTTP ${res.status}`);
    const data = await res.json();
    if (!data.relay) throw new Error("Origin server did not return a relay URL");
    this._resolvedRelay = data.relay;
    return data.relay;
  }
  /**
   * Open the WebSocket connection and start a fresh pairing handshake.
   * Requires `resolveRelay()` to have been called first.
   */
  async connect() {
    if (!this._resolvedRelay) throw new Error("Call resolveRelay() before connect()");
    await this.openConnection(0);
  }
  /**
   * Re-open the WS connection using a stored seq baseline.
   * Replay protection resumes from `lastSeq` — messages with seq ≤ lastSeq are dropped.
   * Use this after a network drop when the session is still valid on the backend.
   * Requires `resolveRelay()` to have been called (relay URL is retained between calls).
   *
   * @param lastSeq - The highest seq received in the previous connection (from persistent storage).
   */
  async reconnect(lastSeq) {
    if (!this._resolvedRelay) throw new Error("Call resolveRelay() before reconnect()");
    await this.openConnection(lastSeq);
  }
  /** Close the WebSocket connection. */
  disconnect() {
    this.ws?.close();
    this.ws = null;
  }
  async openConnection(initialSeq) {
    this._status = "connecting";
    this.connected = false;
    this._lastSeq = initialSeq;
    const { publicKey } = await this.wallet.getPublicKey({ identityKey: true });
    this.mobileIdentityKey = publicKey;
    const { topic, backendIdentityKey } = this.params;
    const cryptoParams = { protocolID: this.protocolID, keyID: topic, counterparty: backendIdentityKey };
    const ws = new WebSocket(`${this._resolvedRelay}/ws?topic=${topic}&role=mobile`);
    this.ws = ws;
    ws.onopen = async () => {
      try {
        const payload = JSON.stringify({
          id: crypto.randomUUID(),
          seq: this._lastSeq + 1,
          method: "pairing_approved",
          params: {
            mobileIdentityKey: publicKey,
            walletMeta: this.options.walletMeta ?? {},
            permissions: Array.from(this.implementedMethods)
          }
        });
        const ciphertext = await encryptEnvelope(this.wallet, cryptoParams, payload);
        const envelope = { topic, mobileIdentityKey: publicKey, ciphertext };
        ws.send(JSON.stringify(envelope));
      } catch (err) {
        this.emitError(err instanceof Error ? err.message : "Failed to send pairing message");
      }
    };
    ws.onmessage = async (event) => {
      try {
        const envelope = JSON.parse(event.data);
        if (!envelope.ciphertext) return;
        let plaintext;
        try {
          plaintext = await decryptEnvelope(this.wallet, cryptoParams, envelope.ciphertext);
        } catch (err) {
          console.warn("[WalletPairingSession] decryptEnvelope failed:", err);
          return;
        }
        const msg = JSON.parse(plaintext);
        if (typeof msg.seq !== "number" || msg.seq <= this._lastSeq) {
          console.warn("[WalletPairingSession] dropping message: seq", msg.seq, "<= lastSeq", this._lastSeq);
          return;
        }
        this._lastSeq = msg.seq;
        if (!this.connected) {
          this.connected = true;
          this._status = "connected";
          this.listeners.connected.forEach((h) => h());
        }
        if ("method" in msg && msg.method === "pairing_ack") return;
        if ("method" in msg && msg.id) {
          await this.handleRpc(msg);
        }
      } catch {
      }
    };
    ws.onerror = () => {
      this.emitError("WebSocket connection failed");
    };
    ws.onclose = () => {
      if (this.ws === null) return;
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.connected) {
        this._status = "disconnected";
        this.listeners.disconnected.forEach((h) => h());
      } else {
        this.emitError("Could not reach the relay \u2014 check that the desktop tab is still open");
      }
    };
  }
  // ── Private ──────────────────────────────────────────────────────────────────
  emitError(msg) {
    this._status = "error";
    this.listeners.error.forEach((h) => h(msg));
  }
  async handleRpc(request) {
    const { topic, backendIdentityKey } = this.params;
    const cryptoParams = { protocolID: this.protocolID, keyID: topic, counterparty: backendIdentityKey };
    const sendResponse = async (response) => {
      const ciphertext = await encryptEnvelope(this.wallet, cryptoParams, JSON.stringify(response));
      this.ws?.send(JSON.stringify({ topic, ciphertext }));
    };
    if (!this.implementedMethods.has(request.method)) {
      await sendResponse({
        id: request.id,
        seq: request.seq,
        error: { code: 501, message: `Method "${request.method}" is not implemented` }
      });
      return;
    }
    const needsApproval = !this.autoApproveMethods.has(request.method);
    if (needsApproval && this.options.onApprovalRequired) {
      const approved = await this.options.onApprovalRequired(request.method, request.params);
      if (!approved) {
        await sendResponse({
          id: request.id,
          seq: request.seq,
          error: { code: 4001, message: "User rejected" }
        });
        return;
      }
    }
    if (!this.requestHandler) {
      await sendResponse({
        id: request.id,
        seq: request.seq,
        error: { code: 501, message: "No request handler registered" }
      });
      return;
    }
    try {
      const result = await this.requestHandler(request.method, request.params);
      await sendResponse({ id: request.id, seq: request.seq, result });
    } catch (err) {
      await sendResponse({
        id: request.id,
        seq: request.seq,
        error: { code: 500, message: err instanceof Error ? err.message : "Handler error" }
      });
    }
  }
};

// src/types.ts
var PROTOCOL_ID = [0, "mobile wallet session"];
var WALLET_METHOD_NAMES = [
  "getPublicKey",
  "listOutputs",
  "createAction",
  "signAction",
  "createSignature",
  "listActions",
  "internalizeAction",
  "acquireCertificate",
  "relinquishCertificate",
  "listCertificates",
  "revealCounterpartyKeyLinkage",
  "createHmac",
  "verifyHmac",
  "encrypt",
  "decrypt",
  "verifySignature"
];

// src/client/WalletRelayClient.ts
var WalletRelayError = class extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
    this.name = "WalletRelayError";
  }
};
var WalletRelayClient = class {
  constructor(options) {
    this._session = null;
    this._desktopToken = null;
    this._log = [];
    this._error = null;
    this._pollTimer = null;
    this._expiredCount = 0;
    this._walletProxy = null;
    const raw = (options?.apiUrl ?? "/api").replace(/\/$/, "");
    this._apiUrl = raw.endsWith("/api") ? raw : `${raw}/api`;
    this._pollInterval = options?.pollInterval ?? 3e3;
    this._connectedPollInterval = options?.connectedPollInterval ?? 1e4;
    this._persistSession = options?.persistSession ?? true;
    this._storageKey = options?.sessionStorageKey ?? `wallet-relay-session:${this._apiUrl}`;
    this._sessionStorageTtl = options?.sessionStorageTtl ?? 24 * 60 * 60 * 1e3;
    this._onSessionChange = options?.onSessionChange;
    this._onLogChange = options?.onLogChange;
    this._onError = options?.onError;
  }
  get session() {
    return this._session;
  }
  get log() {
    return this._log;
  }
  get error() {
    return this._error;
  }
  /**
   * A wallet-interface-compatible proxy that forwards each method call to the
   * connected mobile wallet via the relay. Drop this in anywhere a `WalletClient`
   * is expected — no conditional code paths needed at call sites.
   *
   * ```ts
   * const wallet = client.wallet
   * const { publicKey } = await wallet.getPublicKey({ identityKey: true })
   * const { certificates } = await wallet.listCertificates({ certifiers: [...] })
   * ```
   *
   * Throws if no session is active or if the mobile returns an error.
   * The proxy is created once and reused across calls.
   */
  get wallet() {
    if (!this._walletProxy) {
      const entries = WALLET_METHOD_NAMES.map((method) => [
        method,
        (params) => this.sendRequest(method, params).then((res) => {
          if (res.error) throw Object.assign(new Error(res.error.message), { code: res.error.code });
          return res.result;
        })
      ]);
      this._walletProxy = Object.fromEntries(entries);
    }
    return this._walletProxy;
  }
  /**
   * Attempt to resume a previously persisted session from sessionStorage.
   * Verifies the session is still alive on the server and restarts polling.
   * Returns the resumed SessionInfo, or null if nothing to resume or session expired.
   *
   * Call this before `createSession()` when you want to survive page refreshes:
   * ```ts
   * const session = await client.resumeSession() ?? await client.createSession()
   * ```
   */
  async resumeSession() {
    const stored = this._loadFromStorage();
    if (!stored) return null;
    try {
      const res = await fetch(`${this._apiUrl}/session/${stored.sessionId}`);
      if (!res.ok) {
        this._clearStorage();
        return null;
      }
      const data = await res.json();
      if (data.status === "expired") {
        this._clearStorage();
        return null;
      }
      this._desktopToken = stored.desktopToken;
      const session = { ...data, qrDataUrl: stored.qrDataUrl, pairingUri: stored.pairingUri };
      this._setSession(session);
      const interval = data.status === "connected" ? this._connectedPollInterval : this._pollInterval;
      this._startPolling(stored.sessionId, interval);
      return session;
    } catch {
      return null;
    }
  }
  /**
   * Create a new pairing session and start polling for status changes.
   * Any previously active poll loop is stopped and replaced.
   */
  async createSession() {
    this._stopPolling();
    this._expiredCount = 0;
    this._error = null;
    this._desktopToken = null;
    this._clearStorage();
    try {
      const res = await fetch(`${this._apiUrl}/session`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      this._desktopToken = data.desktopToken ?? null;
      this._setSession(data);
      this._startPolling(data.sessionId);
      return data;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to create session";
      this._error = msg;
      this._onError?.(msg);
      throw new Error(msg);
    }
  }
  /**
   * Send an RPC request to the connected mobile wallet.
   * Appends the request (and eventually its response) to the log.
   * Throws if there is no active session.
   */
  async sendRequest(method, params = {}) {
    if (!this._session) throw new WalletRelayError("No active session", "SESSION_NOT_CONNECTED");
    const requestId = crypto.randomUUID();
    const request = { requestId, method, params, timestamp: Date.now() };
    this._addLogEntry({ request, pending: true });
    try {
      const headers = { "Content-Type": "application/json" };
      if (this._desktopToken) headers["X-Desktop-Token"] = this._desktopToken;
      const res = await fetch(`${this._apiUrl}/request/${this._session.sessionId}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ method, params })
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const msg = body.error ?? `HTTP ${res.status}`;
        let code;
        switch (res.status) {
          case 401:
            code = "INVALID_TOKEN";
            break;
          case 400:
            code = "SESSION_NOT_CONNECTED";
            break;
          case 504:
            code = msg.toLowerCase().includes("disconnect") ? "SESSION_DISCONNECTED" : "REQUEST_TIMEOUT";
            break;
          default:
            code = "NETWORK_ERROR";
        }
        throw new WalletRelayError(msg, code);
      }
      const rpc = await res.json();
      const response = {
        requestId,
        result: rpc.result,
        error: rpc.error,
        timestamp: Date.now()
      };
      this._resolveLogEntry(requestId, response);
      return response;
    } catch (err) {
      let relayErr;
      if (err instanceof WalletRelayError) {
        relayErr = err;
      } else {
        relayErr = new WalletRelayError(err instanceof Error ? err.message : "Request failed", "NETWORK_ERROR");
      }
      this._resolveLogEntry(requestId, {
        requestId,
        error: { code: 500, message: relayErr.message },
        timestamp: Date.now()
      });
      throw relayErr;
    }
  }
  /** Stop polling and clean up resources. Call this on component unmount. */
  destroy() {
    this._stopPolling();
    this._desktopToken = null;
  }
  // ── Private helpers ───────────────────────────────────────────────────────
  _startPolling(sessionId, interval = this._pollInterval) {
    this._pollTimer = setInterval(async () => {
      try {
        const res = await fetch(`${this._apiUrl}/session/${sessionId}`);
        if (!res.ok) return;
        const prevStatus = this._session?.status;
        const updated = await res.json();
        this._setSession({ ...this._session, ...updated });
        if (updated.status === "expired") {
          if (++this._expiredCount >= 2) {
            this._stopPolling();
            this._clearStorage();
          }
        } else {
          this._expiredCount = 0;
          if (updated.status === "connected" && prevStatus !== "connected") {
            this._stopPolling();
            this._startPolling(sessionId, this._connectedPollInterval);
          } else if (updated.status === "disconnected" && prevStatus === "connected") {
            this._stopPolling();
            this._startPolling(sessionId, this._pollInterval);
          }
        }
      } catch {
      }
    }, interval);
  }
  _stopPolling() {
    if (this._pollTimer !== null) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }
  _setSession(session) {
    this._session = session;
    this._saveToStorage();
    this._onSessionChange?.(session);
  }
  _saveToStorage() {
    if (!this._persistSession || !this._session) return;
    try {
      const entry = {
        sessionId: this._session.sessionId,
        desktopToken: this._desktopToken ?? "",
        qrDataUrl: this._session.qrDataUrl,
        pairingUri: this._session.pairingUri,
        status: this._session.status,
        savedAt: Date.now()
      };
      sessionStorage.setItem(this._storageKey, JSON.stringify(entry));
    } catch {
    }
  }
  _clearStorage() {
    try {
      sessionStorage.removeItem(this._storageKey);
    } catch {
    }
  }
  _loadFromStorage() {
    try {
      const raw = sessionStorage.getItem(this._storageKey);
      if (!raw) return null;
      const entry = JSON.parse(raw);
      if (Date.now() - entry.savedAt > this._sessionStorageTtl) {
        this._clearStorage();
        return null;
      }
      return entry;
    } catch {
      return null;
    }
  }
  _addLogEntry(entry) {
    this._log = [entry, ...this._log];
    this._onLogChange?.(this._log);
  }
  _resolveLogEntry(requestId, response) {
    this._log = this._log.map(
      (e) => e.request.requestId === requestId ? { ...e, response, pending: false } : e
    );
    this._onLogChange?.(this._log);
  }
};

// src/shared/pairingUri.ts
var import_sdk2 = require("@bsv/sdk");
var DEFAULT_ACCEPTED_SCHEMAS = /* @__PURE__ */ new Set(["bsv-browser:"]);
function sigPayload(topic, backendIdentityKey, origin, expiry) {
  return Array.from(new TextEncoder().encode(`${topic}|${backendIdentityKey}|${origin}|${expiry}`));
}
function parsePairingUri(raw, acceptedSchemas = DEFAULT_ACCEPTED_SCHEMAS) {
  try {
    const url = new URL(raw);
    if (!acceptedSchemas.has(url.protocol)) return { params: null, error: "URI scheme is not a recognised wallet pairing scheme" };
    const g = (k) => url.searchParams.get(k) ?? "";
    const topic = g("topic");
    const backendIdentityKey = g("backendIdentityKey");
    const protocolID = g("protocolID");
    const origin = g("origin");
    const expiry = g("expiry");
    const sig = url.searchParams.get("sig") ?? void 0;
    if (!topic || !backendIdentityKey || !protocolID || !origin || !expiry) {
      return { params: null, error: "QR code is missing required fields" };
    }
    if (Date.now() / 1e3 > Number(expiry)) {
      return { params: null, error: "This QR code has expired \u2014 ask the desktop to generate a new one" };
    }
    let originUrl;
    try {
      originUrl = new URL(origin);
    } catch {
      return { params: null, error: "Origin URL is not valid" };
    }
    if (originUrl.protocol !== "http:" && originUrl.protocol !== "https:") {
      return { params: null, error: "Origin must use http:// or https://" };
    }
    if (!/^0[23][0-9a-fA-F]{64}$/.test(backendIdentityKey)) {
      return { params: null, error: "Backend identity key is not a valid compressed public key" };
    }
    let proto;
    try {
      proto = JSON.parse(protocolID);
    } catch {
      return { params: null, error: "protocolID is not valid JSON" };
    }
    if (!Array.isArray(proto) || proto.length !== 2 || typeof proto[0] !== "number" || typeof proto[1] !== "string") {
      return { params: null, error: "protocolID must be a [number, string] tuple" };
    }
    return { params: { topic, backendIdentityKey, protocolID, origin, expiry, sig }, error: null };
  } catch {
    return { params: null, error: "Could not read QR code" };
  }
}
async function verifyPairingSignature(params) {
  if (!params.sig) return true;
  try {
    const anyoneWallet = new import_sdk2.ProtoWallet(new import_sdk2.PrivateKey(1));
    const { valid } = await anyoneWallet.verifySignature({
      data: sigPayload(params.topic, params.backendIdentityKey, params.origin, params.expiry),
      signature: base64urlToBytes(params.sig),
      protocolID: [0, "qr pairing"],
      keyID: params.topic,
      counterparty: params.backendIdentityKey
    });
    return valid;
  } catch {
    return false;
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  DEFAULT_ACCEPTED_SCHEMAS,
  DEFAULT_AUTO_APPROVE_METHODS,
  DEFAULT_IMPLEMENTED_METHODS,
  PROTOCOL_ID,
  WALLET_METHOD_NAMES,
  WalletPairingSession,
  WalletRelayClient,
  WalletRelayError,
  base64urlToBytes,
  bytesToBase64url,
  decryptEnvelope,
  encryptEnvelope,
  parsePairingUri,
  verifyPairingSignature
});
//# sourceMappingURL=client.cjs.map