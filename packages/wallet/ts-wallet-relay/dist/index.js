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
    if (role === "desktop") {
      const origin = req.headers.origin;
      if (origin && this.allowedOrigin && origin !== this.allowedOrigin) {
        ws.close(1008, "Origin not allowed");
        return;
      }
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
        const envelope = JSON.parse(`${data}`);
        if (!envelope.topic || !envelope.ciphertext) return;
        const other = role === "mobile" ? entry.desktop : entry.mobile;
        if (other?.readyState === WebSocket.OPEN) {
          other.send(JSON.stringify(envelope));
        } else if (role === "desktop") {
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
var PENDING_EXPIRY_MS = PAIRING_TTL_MS + PAIRING_GRACE_MS + 60 * 1e3;
var SESSION_TTL_MS = 24 * 60 * 60 * 1e3;
var GC_INTERVAL_MS = 10 * 60 * 1e3;
var QRSessionManager = class {
  constructor(options) {
    this.sessions = /* @__PURE__ */ new Map();
    this.onExpired = null;
    this.maxSessions = options?.maxSessions ?? Infinity;
    this.gcTimer = setInterval(() => this.gc(), GC_INTERVAL_MS).unref();
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
    if (this.sessions.size >= this.maxSessions) {
      const err = new Error("Session limit reached");
      err.code = 429;
      throw err;
    }
    const id = randomBytes(32).toString("base64url");
    const desktopToken = randomBytes(24).toString("base64url");
    const now = Date.now();
    const session = {
      id,
      status: "pending",
      createdAt: now,
      // Short TTL — extended to SESSION_TTL_MS when the session becomes connected.
      // This ensures unscanned QR codes are GC'd quickly rather than after 30 days.
      expiresAt: now + PENDING_EXPIRY_MS,
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
    if (session?.status === "pending") session.pairingStartedAt = Date.now();
  }
  setStatus(id, status) {
    const session = this.sessions.get(id);
    if (!session) return;
    session.status = status;
    if (status === "connected") session.expiresAt = Date.now() + SESSION_TTL_MS;
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

// src/types.ts
var PROTOCOL_ID = [0, "mobile wallet session"];

// src/shared/pairingUri.ts
import { ProtoWallet, PrivateKey } from "@bsv/sdk";

// src/shared/encoding.ts
import { Utils } from "@bsv/sdk";
function bytesToBase64url(bytes) {
  return Utils.toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}
function base64urlToBytes(str) {
  return Utils.toArray(str.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

// src/shared/pairingUri.ts
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
function buildPairingUri(params) {
  const expiry = params.expiry ?? Math.floor((Date.now() + (params.pairingTtlMs ?? 12e4)) / 1e3);
  const p = new URLSearchParams({
    topic: params.sessionId,
    backendIdentityKey: params.backendIdentityKey,
    protocolID: params.protocolID,
    origin: params.origin,
    expiry: String(expiry)
  });
  if (params.sig) p.set("sig", params.sig);
  return `${params.schema ?? "bsv-browser"}://pair?${p.toString()}`;
}
async function verifyPairingSignature(params) {
  if (!params.sig) return true;
  try {
    const anyoneWallet = new ProtoWallet(new PrivateKey(1));
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

// src/server/WalletRelayService.ts
var REQUEST_TIMEOUT_MS = 3e4;
var MOBILE_AUTH_TIMEOUT_MS = 15e3;
var WalletRelayService = class {
  constructor(opts) {
    this.opts = opts;
    this.handler = new WalletRequestHandler();
    this.pending = /* @__PURE__ */ new Map();
    this.mobileAuthTimers = /* @__PURE__ */ new Map();
    this.wallet = opts.wallet;
    this.relayUrl = opts.relayUrl ?? process.env["RELAY_URL"] ?? "ws://localhost:3000";
    this.origin = opts.origin ?? process.env["ORIGIN"] ?? "http://localhost:5173";
    this.schema = opts.schema ?? process.env["PAIRING_SCHEMA"] ?? "bsv-browser";
    this.signQrCodes = opts.signQrCodes ?? true;
    this.sessions = new QRSessionManager({ maxSessions: opts.maxSessions });
    this.relay = new WebSocketRelay(opts.server, { allowedOrigin: this.origin });
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
        const authTimer = this.mobileAuthTimers.get(topic);
        if (authTimer) {
          clearTimeout(authTimer);
          this.mobileAuthTimers.delete(topic);
        }
        if (this.sessions.getSession(topic)?.status === "expired") return;
        this.sessions.setStatus(topic, "disconnected");
        this.rejectPendingForSession(topic);
        this.opts.onSessionDisconnected?.(topic);
      }
    });
    if (opts.app) this.registerRoutes(opts.app);
  }
  /** Create a session and return its QR data URL, pairing URI, and desktop WebSocket token. */
  async createSession() {
    const session = this.sessions.createSession();
    const { publicKey: backendIdentityKey } = await this.wallet.getPublicKey({ identityKey: true });
    const expiry = Math.floor((Date.now() + 12e4) / 1e3);
    let sig;
    if (this.signQrCodes) {
      const data = Array.from(
        new TextEncoder().encode(`${session.id}|${backendIdentityKey}|${this.origin}|${expiry}`)
      );
      const { signature } = await this.wallet.createSignature({
        data,
        protocolID: [0, "qr pairing"],
        keyID: session.id,
        counterparty: "anyone"
      });
      sig = bytesToBase64url(signature);
    }
    const uri = buildPairingUri({
      sessionId: session.id,
      backendIdentityKey,
      protocolID: JSON.stringify(PROTOCOL_ID),
      origin: this.origin,
      expiry,
      sig,
      schema: this.schema
    });
    const qrDataUrl = await this.sessions.generateQRCode(uri);
    return { sessionId: session.id, status: session.status, qrDataUrl, pairingUri: uri, desktopToken: session.desktopToken };
  }
  /** Return session status and relay URL, or null if not found. */
  getSession(id) {
    const s = this.sessions.getSession(id);
    return s ? { sessionId: s.id, status: s.status, relay: this.relayUrl } : null;
  }
  /**
   * Encrypt an RPC call, relay it to the mobile, and await the response.
   * Rejects if the session is not connected or if the mobile doesn't respond within 30 s.
   */
  async sendRequest(sessionId, method, params, desktopToken) {
    const session = this.sessions.getSession(sessionId);
    if (session?.status !== "connected" || !session.mobileIdentityKey) {
      const status = session?.status ?? "not found";
      throw new Error(`Session is ${status}`);
    }
    if (desktopToken !== session.desktopToken) {
      throw new Error("Invalid desktop token");
    }
    const rpc = this.handler.createRequest(method, params);
    const ciphertext = await encryptEnvelope(
      this.wallet,
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
  /**
   * Terminate a session from the desktop side: closes the mobile's WebSocket,
   * rejects in-flight requests, and marks the session expired.
   * Throws if the session is not found or the token is invalid.
   */
  deleteSession(sessionId, desktopToken) {
    const session = this.sessions.getSession(sessionId);
    if (!session) throw new Error("Session not found");
    if (session.desktopToken !== desktopToken) throw new Error("Invalid desktop token");
    this.relay.disconnectMobile(sessionId);
    this.rejectPendingForSession(sessionId);
    this.sessions.setStatus(sessionId, "expired");
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
      void this.createSession().then((info) => res.json(info)).catch((err) => {
        const msg = err instanceof Error ? err.message : "Failed";
        const status = err.code === 429 ? 429 : 500;
        res.status(status).json({ error: msg });
      });
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
      const token = req.headers["x-desktop-token"];
      void this.sendRequest(req.params["id"], method, params, token).then((response) => res.json(response)).catch((err) => {
        const msg = err instanceof Error ? err.message : "Request failed";
        let status = 504;
        if (msg === "Invalid desktop token") {
          status = 401;
        } else if (msg.startsWith("Session is")) {
          status = 400;
        }
        res.status(status).json({ error: msg });
      });
    });
    app.delete("/api/session/:id", (req, res) => {
      const token = req.headers["x-desktop-token"];
      if (!token) {
        res.status(401).json({ error: "Missing desktop token" });
        return;
      }
      try {
        this.deleteSession(req.params["id"], token);
        res.status(204).end();
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed";
        const status = msg === "Invalid desktop token" ? 401 : msg === "Session not found" ? 404 : 500;
        res.status(status).json({ error: msg });
      }
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
        this.wallet,
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
        this.wallet,
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
      this.wallet,
      { protocolID: PROTOCOL_ID, keyID: topic, counterparty: mobileIdentityKey },
      JSON.stringify(ack)
    );
    this.relay.sendToMobile(topic, { topic, ciphertext });
  }
};
export {
  DEFAULT_ACCEPTED_SCHEMAS,
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
  parsePairingUri,
  verifyPairingSignature
};
//# sourceMappingURL=index.js.map