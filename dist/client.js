// src/shared/encoding.ts
import { Utils } from "@bsv/sdk";
function bytesToBase64url(bytes) {
  return Utils.toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}
function base64urlToBytes(str) {
  return Utils.toArray(str.replace(/-/g, "+").replace(/_/g, "/"), "base64");
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
var WalletPairingSession = class {
  constructor(wallet, params, options = {}) {
    this.wallet = wallet;
    this.params = params;
    this.options = options;
    this.ws = null;
    this._status = "idle";
    this.connected = false;
    this._lastSeq = 0;
    this.mobileIdentityKey = null;
    this.requestHandler = null;
    this.listeners = { connected: [], disconnected: [], error: [] };
    this.protocolID = JSON.parse(params.protocolID);
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
  /** Open the WS connection and start a fresh pairing handshake. */
  async connect() {
    await this.openConnection(0);
  }
  /**
   * Re-open the WS connection using a stored seq baseline.
   * Replay protection resumes from `lastSeq` — messages with seq ≤ lastSeq are dropped.
   * Use this after a network drop when the session is still valid on the backend.
   *
   * @param lastSeq - The highest seq received in the previous connection (from persistent storage).
   */
  async reconnect(lastSeq) {
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
    const { topic, relay, backendIdentityKey, keyID } = this.params;
    const cryptoParams = { protocolID: this.protocolID, keyID, counterparty: backendIdentityKey };
    const ws = new WebSocket(`${relay}/ws?topic=${topic}&role=mobile`);
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
            permissions: this.options.implementedMethods ? Array.from(this.options.implementedMethods) : []
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
        } catch {
          return;
        }
        const msg = JSON.parse(plaintext);
        if (typeof msg.seq !== "number" || msg.seq <= this._lastSeq) return;
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
    const { topic, keyID, backendIdentityKey } = this.params;
    const cryptoParams = { protocolID: this.protocolID, keyID, counterparty: backendIdentityKey };
    const sendResponse = async (response) => {
      const ciphertext = await encryptEnvelope(this.wallet, cryptoParams, JSON.stringify(response));
      this.ws?.send(JSON.stringify({ topic, ciphertext }));
    };
    if (this.options.implementedMethods && !this.options.implementedMethods.has(request.method)) {
      await sendResponse({
        id: request.id,
        seq: request.seq,
        error: { code: 501, message: `Method "${request.method}" is not implemented` }
      });
      return;
    }
    const needsApproval = !this.options.autoApproveMethods?.has(request.method);
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

// src/shared/pairingUri.ts
function parsePairingUri(raw) {
  try {
    const url = new URL(raw);
    if (url.protocol !== "wallet:") return { params: null, error: "Not a wallet:// URI" };
    const g = (k) => url.searchParams.get(k) ?? "";
    const topic = g("topic");
    const relay = g("relay");
    const backendIdentityKey = g("backendIdentityKey");
    const protocolID = g("protocolID");
    const keyID = g("keyID");
    const origin = g("origin");
    const expiry = g("expiry");
    if (!topic || !relay || !backendIdentityKey || !protocolID || !keyID || !origin || !expiry) {
      return { params: null, error: "QR code is missing required fields" };
    }
    if (Date.now() / 1e3 > Number(expiry)) {
      return { params: null, error: "This QR code has expired \u2014 ask the desktop to generate a new one" };
    }
    let relayUrl;
    try {
      relayUrl = new URL(relay);
    } catch {
      return { params: null, error: "Relay URL is not valid" };
    }
    if (relayUrl.protocol !== "ws:" && relayUrl.protocol !== "wss:") {
      return { params: null, error: "Relay must use ws:// or wss://" };
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
    if (relayUrl.protocol === "wss:" && relayUrl.hostname !== originUrl.hostname) {
      return {
        params: null,
        error: `Relay host "${relayUrl.hostname}" doesn't match origin host "${originUrl.hostname}" \u2014 this QR may be malicious`
      };
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
    if (keyID !== topic) {
      return { params: null, error: "keyID must match topic \u2014 malformed QR code" };
    }
    return { params: { topic, relay, backendIdentityKey, protocolID, keyID, origin, expiry }, error: null };
  } catch {
    return { params: null, error: "Could not read QR code" };
  }
}

// src/types.ts
var PROTOCOL_ID = [0, "mobile wallet session"];
export {
  PROTOCOL_ID,
  WalletPairingSession,
  base64urlToBytes,
  bytesToBase64url,
  decryptEnvelope,
  encryptEnvelope,
  parsePairingUri
};
//# sourceMappingURL=client.js.map