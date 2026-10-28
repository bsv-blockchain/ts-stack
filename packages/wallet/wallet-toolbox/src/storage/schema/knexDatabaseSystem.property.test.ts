import fc from 'fast-check'
import { knexDatabaseSystem } from './knexDatabaseSystem'

const MIN_PROPERTY_RUNS = 300
fc.configureGlobal({
  numRuns: Math.max(MIN_PROPERTY_RUNS, Number(process.env.FAST_CHECK_NUM_RUNS ?? MIN_PROPERTY_RUNS)),
  seed: Number(process.env.FAST_CHECK_SEED ?? 3242026)
})

const aliases = [
  ['sqlite3', 'sqlite'],
  ['better-sqlite3', 'sqlite'],
  ['mysql', 'mysql'],
  ['mysql2', 'mysql'],
  ['pg', 'postgresql'],
  ['postgres', 'postgresql'],
  ['postgresql', 'postgresql'],
  ['unknown', 'unknown']
] as const

describe('independent readers preserve their configured driver family', () => {
  test('string aliases remain authoritative while class clients retain their dialect', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...aliases),
        fc.constantFrom(...aliases),
        fc.jsonValue(),
        (selected, other, annotation) => {
          const configured = { dialect: other[0], config: { client: selected[0], annotation } }
          const copied = { ...configured, config: { ...configured.config } }
          expect(knexDatabaseSystem(configured)).toBe(selected[1])
          expect(knexDatabaseSystem(copied)).toBe(selected[1])
          class OwnedClient {}
          const classClient = { dialect: selected[0], config: { client: OwnedClient, annotation } }
          const independent = { ...classClient, config: { ...classClient.config } }
          expect(independent.config.client).toBe(OwnedClient)
          expect(knexDatabaseSystem(classClient)).toBe(selected[1])
          expect(knexDatabaseSystem(independent)).toBe(selected[1])
          expect(knexDatabaseSystem({ config: { client: OwnedClient } })).toBe('unknown')
        }
      ),
      {
        interruptAfterTimeLimit: 150000,
        markInterruptAsFailure: true,
        path: process.env.FAST_CHECK_PATH ?? process.env.FC_PATH ?? ''
      }
    )
  })
})
