// src/react/useQRPairing.ts
import { useCallback } from "react";
function useQRPairing(pairingUri, options) {
  const open = useCallback(() => {
    if (options?.openUrl) {
      options.openUrl(pairingUri);
    } else if (typeof window !== "undefined") {
      window.location.href = pairingUri;
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
export {
  QRPairingCode,
  useQRPairing
};
//# sourceMappingURL=react.js.map