// src/react/useQRPairing.ts
import { useCallback } from "react";
function useQRPairing(pairingUri, options) {
  const open = useCallback(() => {
    if (options?.openUrl) {
      options.openUrl(pairingUri);
    } else if (globalThis.window !== void 0) {
      globalThis.window.location.href = pairingUri;
    }
  }, [pairingUri, options?.openUrl]);
  return { open, pairingUri };
}

// src/react/QRPairingCode.tsx
import { jsx } from "react/jsx-runtime";
function QRPairingCode({
  qrDataUrl,
  pairingUri,
  onPress,
  imageProps,
  children,
  ...divProps
}) {
  const { open } = useQRPairing(pairingUri, {
    openUrl: onPress ? (uri) => onPress(uri) : void 0
  });
  function handleKeyDown(e) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      open();
    }
  }
  return /* @__PURE__ */ jsx(
    "div",
    {
      role: "button",
      tabIndex: 0,
      ...divProps,
      onClick: open,
      onKeyDown: handleKeyDown,
      children: children ?? /* @__PURE__ */ jsx(
        "img",
        {
          src: qrDataUrl,
          alt: "Scan with BSV wallet",
          ...imageProps
        }
      )
    }
  );
}

// src/react/useWalletRelayClient.ts
import { useCallback as useCallback2, useEffect, useRef, useState } from "react";

// src/types.ts
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
  /**
   * Terminate the session server-side (closes the mobile's WebSocket, marks session
   * expired), then clean up locally. Fire-and-forget safe — errors are swallowed so
   * local teardown always completes.
   *
   * Prefer this over `destroy()` when you want the mobile app to be notified.
   */
  async disconnect() {
    this._stopPolling();
    if (this._session?.sessionId && this._desktopToken) {
      try {
        await fetch(`${this._apiUrl}/session/${this._session.sessionId}`, {
          method: "DELETE",
          headers: { "X-Desktop-Token": this._desktopToken }
        });
      } catch {
      }
    }
    this._desktopToken = null;
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

// src/react/useWalletRelayClient.ts
function useWalletRelayClient(options) {
  const [session, setSession] = useState(null);
  const [log, setLog] = useState([]);
  const [error, setError] = useState(null);
  const clientRef = useRef(null);
  const creatingRef = useRef(null);
  const resumingRef = useRef(null);
  function ensureClient() {
    clientRef.current ?? (clientRef.current = new WalletRelayClient({
      apiUrl: options?.apiUrl,
      pollInterval: options?.pollInterval,
      connectedPollInterval: options?.connectedPollInterval,
      persistSession: options?.persistSession,
      sessionStorageKey: options?.sessionStorageKey,
      sessionStorageTtl: options?.sessionStorageTtl,
      onSessionChange: setSession,
      onLogChange: setLog,
      onError: setError
    }));
    return clientRef.current;
  }
  const createSession = useCallback2(async () => {
    if (creatingRef.current) return creatingRef.current;
    setError(null);
    const promise = ensureClient().createSession().finally(() => {
      if (creatingRef.current === promise) creatingRef.current = null;
    });
    creatingRef.current = promise;
    return promise;
  }, []);
  const resumeSession = useCallback2(async () => {
    if (resumingRef.current) return resumingRef.current;
    setError(null);
    const promise = ensureClient().resumeSession().finally(() => {
      if (resumingRef.current === promise) resumingRef.current = null;
    });
    resumingRef.current = promise;
    return promise;
  }, []);
  const cancelSession = useCallback2(() => {
    const client = clientRef.current;
    clientRef.current = null;
    creatingRef.current = null;
    resumingRef.current = null;
    setSession(null);
    setError(null);
    setLog([]);
    if (client) void client.disconnect();
  }, []);
  const sendRequest = useCallback2(
    async (method, params) => ensureClient().sendRequest(method, params),
    []
    // eslint-disable-line react-hooks/exhaustive-deps
  );
  useEffect(() => {
    const wantCreate = options?.autoCreate !== false;
    const wantResumeOnly = !wantCreate && options?.autoResume === true;
    if (!wantCreate && !wantResumeOnly) return;
    const timer = setTimeout(() => {
      void resumeSession().then((resumed) => {
        if (!resumed && wantCreate) void createSession();
      });
    }, 0);
    return () => {
      clearTimeout(timer);
      const client = clientRef.current;
      clientRef.current = null;
      if (client) void client.disconnect();
    };
  }, [createSession, resumeSession]);
  const wallet = session?.status === "connected" ? clientRef.current?.wallet ?? null : null;
  return { session, log, error, createSession, resumeSession, cancelSession, sendRequest, wallet };
}

// src/react/QRDisplay.tsx
import { jsx as jsx2, jsxs } from "react/jsx-runtime";
var STATUS_TEXT = {
  pending: "Waiting for mobile...",
  connected: "Mobile connected",
  disconnected: "Mobile disconnected",
  expired: "Session expired"
};
function QRDisplay({
  session,
  onRefresh,
  loadingProps,
  statusProps,
  refreshButtonProps,
  qrProps,
  children,
  ...rootProps
}) {
  if (!session) {
    return /* @__PURE__ */ jsx2("div", { "data-state": "loading", ...loadingProps });
  }
  const { status, qrDataUrl, pairingUri } = session;
  const statusText = STATUS_TEXT[status] ?? status;
  const isExpired = status === "expired";
  const isDisconnected = status === "disconnected";
  return /* @__PURE__ */ jsxs("div", { "data-state": status, ...rootProps, children: [
    qrDataUrl && pairingUri ? /* @__PURE__ */ jsx2(QRPairingCode, { qrDataUrl, pairingUri, ...qrProps }) : children,
    /* @__PURE__ */ jsx2("span", { "data-qr-status": status, ...statusProps, children: statusText }),
    (isExpired || isDisconnected) && /* @__PURE__ */ jsx2("button", { type: "button", onClick: onRefresh, ...refreshButtonProps, children: "Generate new QR" })
  ] });
}

// src/react/WalletConnectionModal.tsx
import { useEffect as useEffect2, useRef as useRef2, useState as useState2 } from "react";
import { WalletClient } from "@bsv/sdk";
import { Fragment, jsx as jsx3, jsxs as jsxs2 } from "react/jsx-runtime";
function WalletConnectionModal({
  onLocalWallet,
  onMobileQR,
  installUrl = "https://desktop.bsvb.tech",
  installLabel = "Install BSV Wallet",
  mobileLabel = "Connect via Mobile QR",
  installLinkProps,
  mobileButtonProps,
  children,
  ...rootProps
}) {
  const [status, setStatus] = useState2("detecting");
  const onLocalWalletRef = useRef2(onLocalWallet);
  onLocalWalletRef.current = onLocalWallet;
  useEffect2(() => {
    let cancelled = false;
    const timer = setTimeout(async () => {
      if (cancelled) return;
      try {
        const wallet = new WalletClient("auto");
        const ok = await wallet.isAuthenticated();
        if (!ok) throw new Error("not authenticated");
        if (!cancelled) {
          setStatus("available");
          onLocalWalletRef.current(wallet);
        }
      } catch {
        if (!cancelled) setStatus("unavailable");
      }
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);
  if (status !== "unavailable") return null;
  return /* @__PURE__ */ jsx3("div", { "data-wallet-detection": status, ...rootProps, children: children ?? /* @__PURE__ */ jsxs2(Fragment, { children: [
    /* @__PURE__ */ jsx3(
      "a",
      {
        href: installUrl,
        target: "_blank",
        rel: "noopener noreferrer",
        ...installLinkProps,
        children: installLabel
      }
    ),
    /* @__PURE__ */ jsx3("button", { type: "button", onClick: onMobileQR, ...mobileButtonProps, children: mobileLabel })
  ] }) });
}

// src/react/RequestLog.tsx
import { jsx as jsx4, jsxs as jsxs3 } from "react/jsx-runtime";
function RequestLog({
  entries,
  emptyProps,
  entryProps,
  children,
  ...rootProps
}) {
  if (entries.length === 0) {
    return /* @__PURE__ */ jsx4("div", { "data-state": "empty", ...emptyProps, children: children ?? "No requests yet" });
  }
  return /* @__PURE__ */ jsx4("div", { ...rootProps, children: entries.map((entry) => {
    let state;
    if (entry.pending) {
      state = "pending";
    } else if (entry.response?.error) {
      state = "error";
    } else {
      state = "ok";
    }
    return /* @__PURE__ */ jsxs3("div", { "data-state": state, ...entryProps, children: [
      /* @__PURE__ */ jsx4("span", { "data-log-method": true, children: entry.request.method }),
      /* @__PURE__ */ jsx4("span", { "data-log-status": true, children: state }),
      !entry.pending && entry.response && /* @__PURE__ */ jsx4("pre", { "data-log-result": true, children: JSON.stringify(entry.response.error ?? entry.response.result, null, 2) })
    ] }, entry.request.requestId);
  }) });
}
export {
  QRDisplay,
  QRPairingCode,
  RequestLog,
  WalletConnectionModal,
  useQRPairing,
  useWalletRelayClient
};
//# sourceMappingURL=react.js.map