'use strict'

// A mutation is detected by its first failed assertion. Give the focused
// regression files a chance to detect it before the composed properties.
// Ordering never removes a file: baseline and surviving runs retain every test.
const path = require('node:path')

function key(test) {
  const name = path.relative(test.context.config.rootDir, test.path).split(path.sep).join('/')
  return [name.includes('.property.test.') ? 1 : 0, name]
}

function order(tests) {
  return [...tests].sort((left, right) => {
    const a = key(left)
    const b = key(right)
    if (a[0] !== b[0]) return a[0] - b[0]
    if (a[1] === b[1]) return 0
    return a[1] < b[1] ? -1 : 1
  })
}

class FastFailureSequencer {
  sort(tests) {
    return order(tests)
  }

  allFailedTests(tests) {
    return tests
  }

  cacheResults() {
    // This deterministic ordering has no duration cache to persist.
  }
}

module.exports = FastFailureSequencer
module.exports.order = order
