import { Buffer } from 'node:buffer'
import { withBrc38NativeCandidateContractFixture } from './Brc38NativeCandidateContractFixture'
import {
  brc38NativePackedBinaryLayoutDefinitions,
  verifyBrc38NativePackedDefinitions
} from './Brc38NativePackedSchemaNode'

test('actual packed schema verification amortizes short definitions within the original native packet floor and freshly refuses a mismatch', async () => {
  await withBrc38NativeCandidateContractFixture(
    async fixture => {
      // Construct the genuine private layout, without copying any source rows or
      // replacing its actual native read-only owner with a query mock.
      await fixture.withCandidate(async () => undefined)
      await fixture.withRead(async trx => {
        const expected = await brc38NativePackedBinaryLayoutDefinitions(trx)
        const short = new Map(
          [...expected].filter(
            ([name, item]) =>
              Buffer.byteLength(name) + Buffer.byteLength(item.type) + Buffer.byteLength(item.sql) <= 512
          )
        )
        expect(short.size).toBeGreaterThanOrEqual(24)
        const packets: number[] = []
        const query = (value: { sql: string; bindings: unknown[] }) => {
          if (!value.sql.includes('sqlite_schema')) return
          expect(value.bindings.every(item => typeof item === 'string' || Number.isSafeInteger(item))).toBe(true)
          packets.push(
            8 +
              Buffer.byteLength(value.sql) +
              value.bindings.reduce<number>(
                (sum, item) => sum + (typeof item === 'string' ? 5 + Buffer.byteLength(item) : 9),
                0
              ) +
              8
          )
        }
        trx.on('query', query)
        try {
          await verifyBrc38NativePackedDefinitions(trx, short)
        } finally {
          trx.off('query', query)
        }
        // This independently defined amortization target permits several batch
        // policies. It rejects the previous one-request-per-eight short objects.
        expect(packets.length).toBeGreaterThan(0)
        expect(packets.length).toBeLessThanOrEqual(Math.ceil(short.size / 16))
        // Even the smallest existing native row allowance has a 65,537-byte
        // frame. Include SQL, string-cell framing and request framing here.
        expect(packets.every(bytes => bytes <= 65537)).toBe(true)
        const changed = new Map(short)
        const [name, value] = [...changed].at(-1)!
        changed.set(name, { ...value, sql: value.sql + ' /* independent wrong definition */' })
        await expect(verifyBrc38NativePackedDefinitions(trx, changed)).rejects.toThrow(
          'Packed native source-owned schema differs'
        )
        // The earlier match cannot replace a fresh actual comparison; a refusal
        // also cannot corrupt or consume the original retained read-only view.
        await expect(verifyBrc38NativePackedDefinitions(trx, short)).resolves.toBeUndefined()
      })
    },
    { lifetimeMs: 180000 }
  )
}, 210000)
