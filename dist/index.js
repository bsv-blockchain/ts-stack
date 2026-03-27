// src/server/WebSocketRelay.ts
import { WebSocketServer, WebSocket } from "ws";
var HEARTBEAT_INTERVAL_MS = 3e4;
var BUFFER_TTL_MS = 6e4;
var BUFFER_MAX_PER_TOPIC = 50;
var WebSocketRelay = class {
  constructor(server, options) {
    this.topics = /* @__PURE__ */ new Map();
    this.onMessage = null;
    this.validateTopic = null;
    this.validateDesktopToken = null;
    this.onDisconnectCb = null;
    this.onMobileConnectCb = null;
    this.allowedOrigin = null;
    this.heartbeatTimer = null;
    this.allowedOrigin = options?.allowedOrigin ?? null;
    this.wss = new WebSocketServer({ server, path: "/ws", maxPayload: 64 * 1024 });
    this.wss.on("connection", (ws, req) => this.handleConnection(ws, req));
    this.heartbeatTimer = setInterval(() => this.runHeartbeat(), HEARTBEAT_INTERVAL_MS);
  }
  /** Register a callback for every inbound message from either side. */
  onIncoming(handler) {
    this.onMessage = handler;
  }
  /** Register a validator called on each new connection to verify the topic exists. */
  onValidateTopic(validator) {
    this.validateTopic = validator;
  }
  /**
   * Register a validator for role=desktop connections.
   * Receives the topic and the `token` query parameter (null if absent).
   * Return false to reject the connection with close code 1008.
   */
  onValidateDesktopToken(validator) {
    this.validateDesktopToken = validator;
  }
  /**
   * Register a callback invoked when a socket disconnects.
   * Use this to react to mobile disconnects (e.g. reject in-flight requests).
   */
  onDisconnect(handler) {
    this.onDisconnectCb = handler;
  }
  /** Register a callback invoked when a mobile socket connects (before proof). */
  onMobileConnect(handler) {
    this.onMobileConnectCb = handler;
  }
  /** Forcibly close the mobile socket for a topic (e.g. auth timeout or proof failure). */
  disconnectMobile(topic) {
    const entry = this.topics.get(topic);
    if (entry?.mobile) {
      entry.mobile.close(1008, "Authentication failed");
      entry.mobile = null;
    }
  }
  /** Remove a topic entry — call when its session is garbage-collected. */
  removeTopic(topic) {
    this.topics.delete(topic);
  }
  /** Push an envelope to the mobile socket (or buffer if disconnected). */
  sendToMobile(topic, envelope) {
    const entry = this.topics.get(topic);
    if (entry?.mobile?.readyState === WebSocket.OPEN) {
      entry.mobile.send(JSON.stringify(envelope));
    } else {
      this.buffer(topic, envelope);
    }
  }
  /** Push an envelope to the desktop socket (or buffer if disconnected). */
  sendToDesktop(topic, envelope) {
    const entry = this.topics.get(topic);
    if (entry?.desktop?.readyState === WebSocket.OPEN) {
      entry.desktop.send(JSON.stringify(envelope));
    } else {
      this.buffer(topic, envelope);
    }
  }
  close() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.wss.close();
  }
  // ── Private ──────────────────────────────────────────────────────────────────
  handleConnection(ws, req) {
    const url = new URL(req.url ?? "", "http://localhost");
    const topic = url.searchParams.get("topic");
    const role = url.searchParams.get("role");
    const token = url.searchParams.get("token");
    if (!topic || !role || role !== "desktop" && role !== "mobile") {
      ws.close(1008, "Missing or invalid topic/role");
      return;
    }
    const origin = req.headers.origin;
    if (origin && this.allowedOrigin && origin !== this.allowedOrigin) {
      ws.close(1008, "Origin not allowed");
      return;
    }
    if (this.validateTopic && !this.validateTopic(topic)) {
      ws.close(1008, "Unknown or expired session");
      return;
    }
    if (role === "desktop" && this.validateDesktopToken && !this.validateDesktopToken(topic, token)) {
      ws.close(1008, "Invalid or missing desktop token");
      return;
    }
    const entry = this.getOrCreateTopic(topic);
    entry[role] = ws;
    if (role === "mobile") this.onMobileConnectCb?.(topic);
    const now = Date.now();
    const toFlush = entry.buffer.filter((m) => m.expiresAt > now);
    entry.buffer = [];
    for (const { envelope } of toFlush) {
      ws.send(JSON.stringify(envelope));
    }
    ;
    ws.isAlive = true;
    ws.on("pong", () => {
      ws.isAlive = true;
    });
    ws.on("message", (data) => {
      try {
        const envelope = JSON.parse(data.toString());
        if (!envelope.topic || !envelope.ciphertext) return;
        const other = role === "mobile" ? entry.desktop : entry.mobile;
        if (other?.readyState === WebSocket.OPEN) {
          other.send(JSON.stringify(envelope));
        } else {
          this.buffer(topic, envelope);
        }
        this.onMessage?.(topic, envelope, role);
      } catch {
      }
    });
    ws.on("close", () => {
      if (entry[role] === ws) {
        entry[role] = null;
        this.onDisconnectCb?.(topic, role);
      }
    });
  }
  getOrCreateTopic(topic) {
    if (!this.topics.has(topic)) {
      this.topics.set(topic, { desktop: null, mobile: null, buffer: [] });
    }
    return this.topics.get(topic);
  }
  buffer(topic, envelope) {
    const entry = this.getOrCreateTopic(topic);
    const now = Date.now();
    entry.buffer = entry.buffer.filter((m) => m.expiresAt > now);
    if (entry.buffer.length >= BUFFER_MAX_PER_TOPIC) {
      entry.buffer.shift();
    }
    entry.buffer.push({ envelope, expiresAt: now + BUFFER_TTL_MS });
  }
  runHeartbeat() {
    for (const ws of this.wss.clients) {
      const ext = ws;
      if (!ext.isAlive) {
        ws.terminate();
        continue;
      }
      ext.isAlive = false;
      ws.ping();
    }
  }
};

// src/server/QRSessionManager.ts
import { randomBytes } from "crypto";
var PAIRING_TTL_MS = 120 * 1e3;
var PAIRING_GRACE_MS = 30 * 1e3;
var SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1e3;
var GC_INTERVAL_MS = 10 * 60 * 1e3;
var QRSessionManager = class {
  constructor() {
    this.sessions = /* @__PURE__ */ new Map();
    this.onExpired = null;
    this.gcTimer = setInterval(() => this.gc(), GC_INTERVAL_MS);
  }
  /** Register a callback invoked when a session is garbage-collected. */
  onSessionExpired(cb) {
    this.onExpired = cb;
  }
  /** Stop the GC timer (call on server shutdown). */
  stop() {
    clearInterval(this.gcTimer);
  }
  createSession() {
    const id = randomBytes(32).toString("base64url");
    const desktopToken = randomBytes(24).toString("base64url");
    const now = Date.now();
    const session = {
      id,
      status: "pending",
      createdAt: now,
      expiresAt: now + SESSION_TTL_MS,
      desktopToken
    };
    this.sessions.set(id, session);
    return session;
  }
  getSession(id) {
    const session = this.sessions.get(id);
    if (!session) return null;
    if (session.status === "pending" && Date.now() > session.createdAt + PAIRING_TTL_MS) {
      const gracedUntil = (session.pairingStartedAt ?? 0) + PAIRING_GRACE_MS;
      if (Date.now() > gracedUntil) session.status = "expired";
    }
    return session;
  }
  /** Mark that a mobile WS has opened for this session, starting the grace window. */
  setPairingStarted(id) {
    const session = this.sessions.get(id);
    if (session && session.status === "pending") session.pairingStartedAt = Date.now();
  }
  setStatus(id, status) {
    const session = this.sessions.get(id);
    if (session) session.status = status;
  }
  setMobileIdentityKey(id, key) {
    const session = this.sessions.get(id);
    if (session) session.mobileIdentityKey = key;
  }
  /**
   * Generate a QR data URL for the given URI.
   * Requires the `qrcode` package to be installed.
   */
  async generateQRCode(uri) {
    const QRCode = (await import("qrcode")).default;
    return QRCode.toDataURL(uri, { width: 300, margin: 2 });
  }
  gc() {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now > session.expiresAt) {
        this.sessions.delete(id);
        this.onExpired?.(id);
      }
    }
  }
};

// src/server/WalletRequestHandler.ts
import { randomUUID } from "crypto";
var WalletRequestHandler = class {
  constructor() {
    this.seq = 0;
  }
  /** Create an RPC request with a unique ID and incrementing seq. */
  createRequest(method, params) {
    return { id: randomUUID(), seq: ++this.seq, method, params };
  }
  /** Create a protocol-level message (pairing_ack, session_revoke, …). */
  createProtocolMessage(method, params) {
    return { id: randomUUID(), seq: ++this.seq, method, params };
  }
  parseMessage(raw) {
    return JSON.parse(raw);
  }
  isResponse(msg) {
    return "result" in msg || "error" in msg;
  }
  errorResponse(id, seq, code, message) {
    return { id, seq, error: { code, message } };
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
function buildPairingUri(params) {
  const ttl = params.pairingTtlMs ?? 12e4;
  const expiry = Math.floor((Date.now() + ttl) / 1e3);
  const p = new URLSearchParams({
    topic: params.sessionId,
    relay: params.relayURL,
    backendIdentityKey: params.backendIdentityKey,
    protocolID: params.protocolID,
    keyID: params.sessionId,
    // sessionId doubles as keyID per protocol spec
    origin: params.origin,
    expiry: String(expiry)
  });
  return `wallet://pair?${p.toString()}`;
}

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

// src/types.ts
var PROTOCOL_ID = [0, "mobile wallet session"];

// src/server/WalletRelayService.ts
var REQUEST_TIMEOUT_MS = 3e4;
var MOBILE_AUTH_TIMEOUT_MS = 15e3;
var WalletRelayService = class {
  constructor(opts) {
    this.opts = opts;
    this.handler = new WalletRequestHandler();
    this.pending = /* @__PURE__ */ new Map();
    this.mobileAuthTimers = /* @__PURE__ */ new Map();
    this.sessions = new QRSessionManager();
    this.relay = new WebSocketRelay(opts.server, { allowedOrigin: opts.origin });
    this.sessions.onSessionExpired((id) => this.relay.removeTopic(id));
    this.relay.onValidateTopic((topic) => {
      const s = this.sessions.getSession(topic);
      return s !== null && s.status !== "expired";
    });
    this.relay.onValidateDesktopToken((topic, token) => {
      const s = this.sessions.getSession(topic);
      return s !== null && token !== null && token === s.desktopToken;
    });
    this.relay.onMobileConnect((topic) => {
      const s = this.sessions.getSession(topic);
      if (!s) return;
      this.sessions.setPairingStarted(topic);
      if (s.mobileIdentityKey) return;
      const timer = setTimeout(() => {
        this.mobileAuthTimers.delete(topic);
        this.relay.disconnectMobile(topic);
      }, MOBILE_AUTH_TIMEOUT_MS);
      this.mobileAuthTimers.set(topic, timer);
    });
    this.relay.onIncoming((topic, envelope, role) => {
      if (role === "mobile") void this.handleMobileMessage(topic, envelope);
    });
    this.relay.onDisconnect((topic, role) => {
      if (role === "mobile") {
        this.sessions.setStatus(topic, "disconnected");
        this.rejectPendingForSession(topic);
        this.opts.onSessionDisconnected?.(topic);
      }
    });
    this.registerRoutes(opts.app);
  }
  /** Create a session and return its QR data URL, pairing URI, and desktop WebSocket token. */
  async createSession() {
    const session = this.sessions.createSession();
    const { publicKey: backendIdentityKey } = await this.opts.wallet.getPublicKey({ identityKey: true });
    const uri = buildPairingUri({
      sessionId: session.id,
      relayURL: this.opts.relayUrl,
      backendIdentityKey,
      protocolID: JSON.stringify(PROTOCOL_ID),
      origin: this.opts.origin
    });
    const qrDataUrl = await this.sessions.generateQRCode(uri);
    return { sessionId: session.id, status: session.status, qrDataUrl, pairingUri: uri, desktopToken: session.desktopToken };
  }
  /** Return session status, or null if not found. */
  getSession(id) {
    const s = this.sessions.getSession(id);
    return s ? { sessionId: s.id, status: s.status } : null;
  }
  /**
   * Encrypt an RPC call, relay it to the mobile, and await the response.
   * Rejects if the session is not connected or if the mobile doesn't respond within 30 s.
   */
  async sendRequest(sessionId, method, params) {
    const session = this.sessions.getSession(sessionId);
    if (!session || session.status !== "connected" || !session.mobileIdentityKey) {
      const status = session?.status ?? "not found";
      throw new Error(`Session is ${status}`);
    }
    const rpc = this.handler.createRequest(method, params);
    const ciphertext = await encryptEnvelope(
      this.opts.wallet,
      { protocolID: PROTOCOL_ID, keyID: sessionId, counterparty: session.mobileIdentityKey },
      JSON.stringify(rpc)
    );
    this.relay.sendToMobile(sessionId, { topic: sessionId, ciphertext });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(rpc.id);
        reject(new Error("Request timed out"));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(rpc.id, { sessionId, resolve, reject, timer });
    });
  }
  /** Stop the GC timer, close the WebSocket server, and reject all in-flight requests. */
  stop() {
    for (const timer of this.mobileAuthTimers.values()) clearTimeout(timer);
    this.mobileAuthTimers.clear();
    this.rejectPendingForSession(null);
    this.sessions.stop();
    this.relay.close();
  }
  // ── Private helpers ───────────────────────────────────────────────────────────
  /**
   * Reject all pending requests belonging to a session.
   * Pass null to reject every pending request (used on full shutdown).
   */
  rejectPendingForSession(sessionId) {
    for (const [id, pending] of this.pending) {
      if (sessionId === null || pending.sessionId === sessionId) {
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(new Error(sessionId === null ? "Server shutting down" : "Session disconnected"));
      }
    }
  }
  // ── Route registration ────────────────────────────────────────────────────────
  registerRoutes(app) {
    app.get("/api/session", (req, res) => {
      void this.createSession().then((info) => res.json(info)).catch((err) => res.status(500).json({ error: err instanceof Error ? err.message : "Failed" }));
    });
    app.get("/api/session/:id", (req, res) => {
      const info = this.getSession(req.params["id"]);
      if (!info) {
        res.status(404).json({ error: "Session not found" });
        return;
      }
      res.json(info);
    });
    app.post("/api/request/:id", (req, res) => {
      const { method, params } = req.body;
      if (!method) {
        res.status(400).json({ error: "method is required" });
        return;
      }
      void this.sendRequest(req.params["id"], method, params).then((response) => res.json(response)).catch((err) => {
        const msg = err instanceof Error ? err.message : "Request failed";
        const status = msg.startsWith("Session is") ? 400 : 504;
        res.status(status).json({ error: msg });
      });
    });
  }
  // ── Inbound message handling ──────────────────────────────────────────────────
  async handleMobileMessage(topic, envelope) {
    const session = this.sessions.getSession(topic);
    if (!session) return;
    if (envelope.mobileIdentityKey && session.status !== "expired") {
      if (session.mobileIdentityKey && session.mobileIdentityKey !== envelope.mobileIdentityKey) {
        this.relay.disconnectMobile(topic);
        return;
      }
      await this.handlePairingApproved(topic, envelope);
      return;
    }
    if (!session.mobileIdentityKey) return;
    let plaintext;
    try {
      plaintext = await decryptEnvelope(
        this.opts.wallet,
        { protocolID: PROTOCOL_ID, keyID: topic, counterparty: session.mobileIdentityKey },
        envelope.ciphertext
      );
    } catch {
      return;
    }
    const msg = this.handler.parseMessage(plaintext);
    if (this.handler.isResponse(msg)) {
      const pending = this.pending.get(msg.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(msg.id);
        pending.resolve(msg);
      }
    }
  }
  async handlePairingApproved(topic, envelope) {
    const mobileIdentityKey = envelope.mobileIdentityKey;
    let plaintext;
    try {
      plaintext = await decryptEnvelope(
        this.opts.wallet,
        { protocolID: PROTOCOL_ID, keyID: topic, counterparty: mobileIdentityKey },
        envelope.ciphertext
      );
    } catch {
      this.relay.disconnectMobile(topic);
      return;
    }
    const msg = this.handler.parseMessage(plaintext);
    if (msg.params?.mobileIdentityKey && msg.params.mobileIdentityKey !== mobileIdentityKey) {
      this.relay.disconnectMobile(topic);
      return;
    }
    const timer = this.mobileAuthTimers.get(topic);
    if (timer) {
      clearTimeout(timer);
      this.mobileAuthTimers.delete(topic);
    }
    this.sessions.setMobileIdentityKey(topic, mobileIdentityKey);
    this.sessions.setStatus(topic, "connected");
    this.opts.onSessionConnected?.(topic);
    const ack = this.handler.createProtocolMessage("pairing_ack", { topic });
    const ciphertext = await encryptEnvelope(
      this.opts.wallet,
      { protocolID: PROTOCOL_ID, keyID: topic, counterparty: mobileIdentityKey },
      JSON.stringify(ack)
    );
    this.relay.sendToMobile(topic, { topic, ciphertext });
  }
};
export {
  PROTOCOL_ID,
  QRSessionManager,
  WalletRelayService,
  WalletRequestHandler,
  WebSocketRelay,
  base64urlToBytes,
  buildPairingUri,
  bytesToBase64url,
  decryptEnvelope,
  encryptEnvelope,
  parsePairingUri
};
//# sourceMappingURL=index.js.map