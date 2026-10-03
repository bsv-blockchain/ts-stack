import base from './jest.config.js'

// Preserve complete discovery and one global coverage gate while bounding each
// native ESM worker's retained state between suites. Mutation options are separate.
export default {
  ...base,
  maxWorkers: 2,
  workerIdleMemoryLimit: '1GB'
}
