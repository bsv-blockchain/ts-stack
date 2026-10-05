import * as canonicalSDK from '../mod.js'

// Preserve the classic global shape without creating a second class graph.
const globalSDK = {}
Object.defineProperty(globalSDK, '__esModule', { value: true })
Object.defineProperty(globalSDK, Symbol.toStringTag, { value: 'Module' })
for (const name of Object.keys(canonicalSDK)) {
  Object.defineProperty(globalSDK, name, {
    enumerable: true,
    get: () => canonicalSDK[name as keyof typeof canonicalSDK]
  })
}
Object.assign(globalThis, { bsv: globalSDK })

export * from '../mod.js'
