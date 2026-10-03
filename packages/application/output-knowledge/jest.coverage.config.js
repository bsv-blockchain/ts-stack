import base from './jest.config.js'

// Preserve complete discovery and one global coverage gate while bounding each
// native ESM worker's retained state between suites. Run native property histories
// serially so concurrent suites cannot consume their unchanged wall-clock budget.
// Mutation options are separate.
export default {
  ...base,
  maxWorkers: 1,
  workerIdleMemoryLimit: '1GB'
}
