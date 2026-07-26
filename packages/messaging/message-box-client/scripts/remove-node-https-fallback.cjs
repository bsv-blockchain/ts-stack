'use strict'

/**
 * Older SDK artifacts included a guarded CommonJS `require("node:https")`
 * fallback for old Node runtimes. Webpack left that unreachable string in UMD
 * output, where the browser composition gate rejected it. Browser clients use
 * fetch, so remove only this exact legacy fallback when it is present.
 *
 * Newer SDK artifacts already hide the optional Node module identifier from
 * static browser analysis. Those inputs are safe and require no transformation.
 */
module.exports = function removeNodeHttpsFallback(source) {
  return source.replace(/require\((['"])node:https\1\)/g, 'undefined')
}
