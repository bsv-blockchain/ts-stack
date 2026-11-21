import { createHash } from 'node:crypto'
import type { KnexBrc38StagingStore } from './KnexBrc38StagingStore'
import { Brc38NativeLocalBaselineSource } from './Brc38NativeLocalBaselineSourceNode'
import {
  withBrc38NativeLocalStructuredSource,
  withBrc38NativeLocalStructuredDatabaseSource
} from './Brc38NativeLocalStructuredSourceNode'
import type { Brc38PrivateCurrentStructuredPolicy } from './Brc38PrivateCurrentStructuredSourceNode'
import { Brc38WorkingAllocation } from './Brc38WorkingAllocation'
import { visitBrc38StructuredJsonValues, type Brc38StreamedStructured } from './Brc38StructuredJson'

interface ActualController {
  readonly store: KnexBrc38StagingStore
  readonly policy: Brc38PrivateCurrentStructuredPolicy
  withSource<T>(work: (source: Brc38NativeLocalBaselineSource) => Promise<T>): Promise<T>
  check(): void
}
function requireCase(value: unknown): asserts value {
  if (!value)
    throw new Error('Coherent local structured source differs from its independent bytes, grammar or lifetime')
}
/** UNRUN genuine local original history/notify fixtures. Independent raw bytes
 * and grammar events include duplicate members, legacy ordering/spelling and
 * Unicode crossing transfers. Run with original local transfer widths below
 * 64 as well as normal widths: the factory assembles bounded parser windows.
 * No fake source/producer, replacement kernel, digest oracle or empty fallback. */
export async function verifyBrc38NativeLocalStructuredSource(
  controller: ActualController,
  rowId: number,
  field: 'history' | 'notify',
  expected: Uint8Array,
  expectedEvents: readonly unknown[],
  mode: 'transaction' | 'database' = 'transaction'
): Promise<void> {
  const working = controller.policy.workingAllocation
  requireCase(
    working !== undefined &&
      expected instanceof Uint8Array &&
      expected.length >= 2 &&
      expected.length <= 1048576 &&
      Number.isSafeInteger(rowId) &&
      expectedEvents.length <= 128 &&
      (mode === 'transaction' || mode === 'database')
  )
  const used = working.used,
    hash = createHash('sha256').update(expected).digest('hex')
  let escaped: Readonly<Brc38StreamedStructured> | undefined, pending: Promise<Uint8Array> | undefined
  await controller.withSource(async source => {
    Brc38NativeLocalBaselineSource.assertSharedWorking(source, working)
    let refused = false
    try {
      Brc38NativeLocalBaselineSource.assertSharedWorking(source, new Brc38WorkingAllocation(working.maximum))
    } catch {
      refused = true
    }
    requireCase(refused)
    const consume = async (
      actual: Readonly<Brc38StreamedStructured>,
      descriptor: Readonly<{ bytes: number; sha256: string }>
    ): Promise<void> => {
      escaped = actual
      requireCase(
        descriptor.bytes === expected.length &&
          descriptor.sha256 === hash &&
          actual.length === expected.length &&
          actual.sha256 === hash
      )
      const width = Math.min(997, controller.policy.maximumReadBytes ?? 65536)
      for (let offset = 0; offset < expected.length;) {
        const length = Math.min(width, expected.length - offset),
          bytes = await actual.read(offset, length)
        try {
          requireCase(bytes.length === length && bytes.every((value, index) => value === expected[offset + index]))
        } finally {
          bytes.fill(0)
        }
        offset += length
      }
      const events: unknown[] = []
      await visitBrc38StructuredJsonValues(
        actual,
        {
          maximumInputBytes: controller.policy.maximumStructuredBytes,
          maximumOutputBytes: controller.policy.maximumCanonicalBytes,
          maximumChunkBytes: controller.policy.maximumReadBytes ?? 65536,
          maximumAllocationBytes: controller.policy.maximumGrammarAllocationBytes,
          workingAllocation: working,
          signal: controller.policy.signal
        },
        {
          enter: (path, kind, offset) => {
            events.push(['enter', path, kind, offset])
            requireCase(events.length <= 128)
          },
          text: (path, value) => {
            events.push(['text', path, value])
            requireCase(events.length <= 128)
          },
          number: (path, value) => {
            events.push(['number', path, value])
            requireCase(events.length <= 128)
          },
          boolean: (path, value) => {
            events.push(['boolean', path, value])
            requireCase(events.length <= 128)
          },
          null: path => {
            events.push(['null', path])
            requireCase(events.length <= 128)
          },
          end: (path, offset) => {
            events.push(['end', path, offset])
            requireCase(events.length <= 128)
          }
        }
      )
      requireCase(JSON.stringify(events) === JSON.stringify(expectedEvents))
      // Actual queued transport must drain before the real row lease closes.
      pending = actual.read(0, Math.min(width, expected.length))
    }
    await controller.store.withAuthenticatedPrivateStructuredDestination(
      async () =>
        await controller.store.withPrivateNativeDatabase(true, async database => {
          if (mode === 'transaction')
            await database.transaction(
              async k =>
                await withBrc38NativeLocalStructuredSource(
                  controller.store,
                  source,
                  k,
                  rowId,
                  field,
                  controller.policy,
                  consume
                )
            )
          else {
            let wrongFacadeRefused = false
            try {
              await withBrc38NativeLocalStructuredDatabaseSource(
                controller.store,
                source,
                controller.store.knex,
                rowId,
                field,
                controller.policy,
                consume
              )
            } catch {
              wrongFacadeRefused = true
            }
            requireCase(wrongFacadeRefused && escaped === undefined && pending === undefined)
            await withBrc38NativeLocalStructuredDatabaseSource(
              controller.store,
              source,
              database,
              rowId,
              field,
              controller.policy,
              consume
            )
          }
        })
    )
  })
  requireCase(pending !== undefined && escaped !== undefined)
  const bytes = await pending
  try {
    requireCase(bytes.every((value, index) => value === expected[index]))
  } finally {
    bytes.fill(0)
  }
  let refused = false
  try {
    await escaped.read(0, 1)
  } catch {
    refused = true
  }
  requireCase(refused && working.used === used)
  controller.check()
}
