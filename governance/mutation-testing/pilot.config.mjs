import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import config from './stryker.config.mjs'

const variants = new Set(['baseline', 'candidate'])
if (!variants.has(process.env.TS_STACK_MUTATION_PILOT_VARIANT))
  throw new Error('Pilot requires an explicit baseline or candidate variant')
if (
  !new Set([
    'private-purchase-native-clock',
    'private-purchase-disclosure',
    'private-lookup-buyer'
  ]).has(process.env.TS_STACK_MUTATION_TARGET)
)
  throw new Error('Target is outside the three-boundary pilot')
const run = process.env.TS_STACK_MUTATION_PILOT_RUN
if (!/^[a-z0-9-]{8,80}$/.test(run ?? '')) throw new Error('Pilot requires a bounded run identity')
const report = resolve(
  fileURLToPath(new URL('../..', import.meta.url)),
  'artifacts/mutation-pilot',
  run,
  process.env.TS_STACK_MUTATION_TARGET,
  process.env.TS_STACK_MUTATION_PILOT_VARIANT,
  process.env.TS_STACK_MUTATION_PARTITION,
  'mutation.json'
)

// This diagnostic config supplies no publication receipt. Both arms use the
// original selection, operators, seed, deadlines, worker limits and source.
export default {
  ...config,
  reporters: ['progress-append-only', 'json'],
  jsonReporter: { fileName: report },
  ...(process.env.TS_STACK_MUTATION_PILOT_VARIANT === 'candidate'
    ? {
        jest: {
          ...config.jest,
          config: {
            ...config.jest.config,
            testSequencer: fileURLToPath(new URL('./fast-failure-sequencer.cjs', import.meta.url))
          }
        }
      }
    : {})
}
