import { BdkVerifier } from '@bsv/verifast'

declare global {
  interface Window {
    __VERIFAST_FALLBACK_RESULT__?: boolean
    __VERIFAST_FALLBACK_ERROR__?: string
  }
}

try {
  const verifier = new BdkVerifier({ registerAsDefault: false })
  await verifier.preload()
  window.__VERIFAST_FALLBACK_RESULT__ = verifier.isReady()
  document.querySelector('#result')!.textContent = String(window.__VERIFAST_FALLBACK_RESULT__)
} catch (error) {
  window.__VERIFAST_FALLBACK_ERROR__ =
    error instanceof Error ? (error.stack ?? error.message) : String(error)
}
