'use strict'

const path = require('node:path')
const anymatch = require('anymatch')
const isGlob = require('is-glob')
const { bus } = require('nodemon/lib/utils')
const { rulesToMonitor } = require('nodemon/lib/monitor/match')

function unix(value) {
  const slashes = value.replaceAll('\\', '/')
  return (slashes.startsWith('//') ? '/' : '') + slashes.replaceAll(/\/{2,}/g, '/')
}
function normalizeIgnored(value, cwd) {
  if (typeof value !== 'string') return value
  const joined = path.isAbsolute(value) ? value : path.join(cwd ?? '', value)
  return unix(path.normalize(unix(joined)))
}

/** Nodemon already expands watched globs into literal directories. Chokidar4
 * also needs the former glob-aware ignore predicate, including literal-directory
 * recursion and custom ignored functions/regexes. Retain its published anymatch
 * matcher instead of the removed braces-dependent watch-path expansion. */
function applyOptions(config) {
  const options = config.options.watchOptions ?? {}
  let ignored
  if (Object.hasOwn(options, 'ignored')) ignored = options.ignored
  else {
    ignored = rulesToMonitor([], Array.from(config.options.ignore), config).map(pattern =>
      pattern.slice(1)
    )
    const dotFile = /[/\\]\./
    if (!config.dirs.some(directory => dotFile.test(directory))) ignored.push(dotFile)
  }
  const normalized = (Array.isArray(ignored) ? ignored : [ignored]).map(value =>
    normalizeIgnored(value, options.cwd)
  )
  const directories = normalized
    .filter(value => typeof value === 'string' && !isGlob(value))
    .map(value => value + '/**')
  const predicate = anymatch([...normalized, ...directories], undefined, { dot: true })
  config.options.watchOptions = { ...options, ignored: (file, stats) => predicate([file, stats]) }
}

module.exports = applyOptions
if (require.main === module) {
  bus.on('config:update', applyOptions)
  require('nodemon/bin/nodemon.js')
}
