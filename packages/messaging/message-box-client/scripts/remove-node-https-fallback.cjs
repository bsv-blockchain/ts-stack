'use strict'

/**
 * The SDK's browser-safe default HTTP client includes a guarded CommonJS
 * `require("node:https")` fallback for old Node runtimes. Webpack leaves that
 * unreachable string in UMD output, where the browser composition gate must
 * reject it. Browser clients use fetch, so remove only this exact fallback.
 */
module.exports = function removeNodeHttpsFallback(source) {
  const transformed = source.replace(/require\((['"])node:https\1\)/g, 'undefined')
  if (transformed === source) {
    throw new Error('Expected the SDK node:https fallback in the browser build input.')
  }
  return transformed
}
