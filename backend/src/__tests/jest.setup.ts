/**
 * Jest setup file to ensure proper type resolution
 */

// Import Jest types globally
import '@jest/globals'

// Extend global namespace with Jest types
declare global {
  var expect: typeof import('@jest/globals').expect
  var describe: typeof import('@jest/globals').describe
  var it: typeof import('@jest/globals').it
  var test: typeof import('@jest/globals').test
  var beforeAll: typeof import('@jest/globals').beforeAll
  var beforeEach: typeof import('@jest/globals').beforeEach
  var afterAll: typeof import('@jest/globals').afterAll
  var afterEach: typeof import('@jest/globals').afterEach
}
