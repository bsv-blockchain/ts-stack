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

// src/react.tsx
var react_exports = {};
__export(react_exports, {
  QRDisplay: () => QRDisplay,
  QRPairingCode: () => QRPairingCode,
  RequestLog: () => RequestLog,
  WalletConnectionModal: () => WalletConnectionModal,
  useQRPairing: () => useQRPairing,
  useWalletRelayClient: () => useWalletRelayClient
});
module.exports = __toCommonJS(react_exports);

// src/react/useQRPairing.ts
var import_react = require("react");
function useQRPairing(pairingUri, options) {
  const open = (0, import_react.useCallback)(() => {
    if (options?.openUrl) {
      options.openUrl(pairingUri);
    } else if (typeof window !== "undefined") {
      window.location.href = pairingUri;
    }
  }, [pairingUri, options?.openUrl]);
  return { open, pairingUri };
}

// src/react/QRPairingCode.tsx
var import_jsx_runtime = require("react/jsx-runtime");
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
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
    "div",
    {
      role: "button",
      tabIndex: 0,
      ...divProps,
      onClick: open,
      onKeyDown: handleKeyDown,
      children: children ?? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
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
var import_react2 = require("react");

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
   * Create a new pairing session and start polling for status changes.
   * Any previously active poll loop is stopped and replaced.
   */
  async createSession() {
    this._stopPolling();
    this._expiredCount = 0;
    this._error = null;
    this._desktopToken = null;
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
    if (!this._session) throw new Error("No active session");
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
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
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
      const msg = err instanceof Error ? err.message : "Request failed";
      const response = {
        requestId,
        error: { code: 500, message: msg },
        timestamp: Date.now()
      };
      this._resolveLogEntry(requestId, response);
      throw new Error(msg);
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
          if (++this._expiredCount >= 2) this._stopPolling();
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
    this._onSessionChange?.(session);
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
  const [session, setSession] = (0, import_react2.useState)(null);
  const [log, setLog] = (0, import_react2.useState)([]);
  const [error, setError] = (0, import_react2.useState)(null);
  const clientRef = (0, import_react2.useRef)(null);
  const createdRef = (0, import_react2.useRef)(false);
  function ensureClient() {
    if (!clientRef.current) {
      clientRef.current = new WalletRelayClient({
        apiUrl: options?.apiUrl,
        pollInterval: options?.pollInterval,
        onSessionChange: setSession,
        onLogChange: setLog,
        onError: setError
      });
    }
    return clientRef.current;
  }
  const createSession = (0, import_react2.useCallback)(async () => {
    setError(null);
    return ensureClient().createSession();
  }, []);
  const sendRequest = (0, import_react2.useCallback)(
    async (method, params) => ensureClient().sendRequest(method, params),
    []
    // eslint-disable-line react-hooks/exhaustive-deps
  );
  (0, import_react2.useEffect)(() => {
    if (options?.autoCreate === false) return;
    if (createdRef.current) return;
    createdRef.current = true;
    const timer = setTimeout(() => {
      void createSession();
    }, 0);
    return () => {
      clearTimeout(timer);
      createdRef.current = false;
      clientRef.current?.destroy();
      clientRef.current = null;
    };
  }, [createSession]);
  const wallet = session?.status === "connected" ? clientRef.current?.wallet ?? null : null;
  return { session, log, error, createSession, sendRequest, wallet };
}

// src/react/QRDisplay.tsx
var import_jsx_runtime2 = require("react/jsx-runtime");
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
    return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { "data-state": "loading", ...loadingProps });
  }
  const { status, qrDataUrl, pairingUri } = session;
  const statusText = STATUS_TEXT[status] ?? status;
  const isExpired = status === "expired";
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { "data-state": status, ...rootProps, children: [
    qrDataUrl && pairingUri ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(QRPairingCode, { qrDataUrl, pairingUri, ...qrProps }) : children,
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { "data-qr-status": status, ...statusProps, children: statusText }),
    isExpired && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("button", { type: "button", onClick: onRefresh, ...refreshButtonProps, children: "Generate new QR" })
  ] });
}

// src/react/WalletConnectionModal.tsx
var import_react3 = require("react");
var import_sdk = require("@bsv/sdk");
var import_jsx_runtime3 = require("react/jsx-runtime");
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
  const [status, setStatus] = (0, import_react3.useState)("detecting");
  const onLocalWalletRef = (0, import_react3.useRef)(onLocalWallet);
  onLocalWalletRef.current = onLocalWallet;
  (0, import_react3.useEffect)(() => {
    let cancelled = false;
    const timer = setTimeout(async () => {
      if (cancelled) return;
      try {
        const wallet = new import_sdk.WalletClient("auto");
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
  return /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { "data-wallet-detection": status, ...rootProps, children: children ?? /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)(import_jsx_runtime3.Fragment, { children: [
    /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
      "a",
      {
        href: installUrl,
        target: "_blank",
        rel: "noopener noreferrer",
        ...installLinkProps,
        children: installLabel
      }
    ),
    /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("button", { type: "button", onClick: onMobileQR, ...mobileButtonProps, children: mobileLabel })
  ] }) });
}

// src/react/RequestLog.tsx
var import_jsx_runtime4 = require("react/jsx-runtime");
function RequestLog({
  entries,
  emptyProps,
  entryProps,
  children,
  ...rootProps
}) {
  if (entries.length === 0) {
    return /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("div", { "data-state": "empty", ...emptyProps, children: children ?? "No requests yet" });
  }
  return /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("div", { ...rootProps, children: entries.map((entry) => {
    const state = entry.pending ? "pending" : entry.response?.error ? "error" : "ok";
    return /* @__PURE__ */ (0, import_jsx_runtime4.jsxs)("div", { "data-state": state, ...entryProps, children: [
      /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("span", { "data-log-method": true, children: entry.request.method }),
      /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("span", { "data-log-status": true, children: state }),
      !entry.pending && entry.response && /* @__PURE__ */ (0, import_jsx_runtime4.jsx)("pre", { "data-log-result": true, children: JSON.stringify(entry.response.error ?? entry.response.result, null, 2) })
    ] }, entry.request.requestId);
  }) });
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  QRDisplay,
  QRPairingCode,
  RequestLog,
  WalletConnectionModal,
  useQRPairing,
  useWalletRelayClient
});
//# sourceMappingURL=react.cjs.map