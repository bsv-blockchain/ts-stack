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
  QRPairingCode: () => QRPairingCode,
  useQRPairing: () => useQRPairing
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
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  QRPairingCode,
  useQRPairing
});
//# sourceMappingURL=react.cjs.map