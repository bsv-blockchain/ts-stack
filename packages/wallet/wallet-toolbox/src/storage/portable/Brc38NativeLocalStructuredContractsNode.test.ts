import { withBrc38NativeCandidateContractFixture } from './Brc38NativeCandidateContractFixture'
import { verifyBrc38NativeLocalStructuredSource } from './Brc38NativeLocalStructuredSourceNode.case'
import { Brc38PublishedProfileNode } from './Brc38PublishedProfileNode'
import { writeBrc38NativePackedTextBytes } from './Brc38NativePackedTextFieldsNode'

// Admit the existing 180-second fixture owner plus 30 seconds of cleanup.
const nativeFixtureCaseTimeoutMs = 180000 + 30000

// Independently authored original spelling. The duplicate's last value is
// visible to the grammar visitor; every original byte is still checked by the
// source helper, including the overwritten text crossing transfer boundaries.
const spelling = '{ "skip":"' + 'a'.repeat(54) + '雪😀", "skip":2, "unicode":"雪😀", "z":[true,null] }',
  expected = Buffer.from(spelling),
  at = (text: string): number => {
    const offset = expected.indexOf(Buffer.from(text))
    if (offset < 0) throw new Error('Independent structured fixture token missing')
    return offset
  },
  numberAt = at('2,'),
  unicodeAt = at('"雪😀", "z"'),
  arrayAt = at('[true,null]'),
  trueAt = at('true'),
  nullAt = at('null'),
  events = [
    ['enter', [], 'object', 0],
    ['enter', ['skip'], 'number', numberAt],
    ['number', ['skip'], 2],
    ['end', ['skip'], numberAt + 1],
    ['enter', ['unicode'], 'string', unicodeAt],
    ['text', ['unicode'], '雪😀'],
    ['end', ['unicode'], unicodeAt + Buffer.byteLength('"雪😀"')],
    ['enter', ['z'], 'array', arrayAt],
    ['enter', ['z', 0], 'boolean', trueAt],
    ['boolean', ['z', 0], true],
    ['end', ['z', 0], trueAt + 4],
    ['enter', ['z', 1], 'null', nullAt],
    ['null', ['z', 1]],
    ['end', ['z', 1], nullAt + 4],
    ['end', ['z'], arrayAt + Buffer.byteLength('[true,null]')],
    ['end', [], expected.length]
  ]

test.each([
  ['history', 'transaction', 32, 64],
  ['history', 'database', 1024, 1024],
  ['notify', 'transaction', 1024, 64],
  ['notify', 'database', 32, 1024]
] as const)(
  'actual original %s structured source retains its %s scope and %i-byte local transfers',
  async (field, mode, sourceWidth, parserWidth) => {
    let rowId: number | undefined
    await withBrc38NativeCandidateContractFixture(
      async fixture => {
        if (rowId === undefined) throw new Error('Independent original structured row missing')
        const policy = {
          ...fixture.options.structuredResources.sourcePolicy,
          maximumReadBytes: parserWidth,
          workingAllocation: fixture.options.workingAllocation,
          expiresAt: fixture.store.limits.expiresAt,
          maximumCombinedTemporaryBytes: fixture.store.limits.maximumPhysicalBytes
        }
        await verifyBrc38NativeLocalStructuredSource({ ...fixture, policy }, rowId, field, expected, events, mode)
      },
      {
        maximumSourceReadBytes: sourceWidth,
        prepareSource: async source => {
          await source.manager.runAsStorageProvider(async active => {
            if (active !== source.storage) throw new Error('Independent original JSON fixture selected another source')
            await Brc38PublishedProfileNode.withNativeImmediateSourceWriter(source.storage, async writer => {
              const rows = await writer('proven_tx_reqs').select('provenTxReqId').limit(2)
              if (rows.length !== 1 || !Number.isSafeInteger(Number(rows[0].provenTxReqId)))
                throw new Error('Independent original JSON fixture requires one actual request')
              rowId = Number(rows[0].provenTxReqId)
              await writeBrc38NativePackedTextBytes(writer, { table: 'provenTxReqs', field, rowId }, expected)
            })
          })
        }
      }
    )
  },
  nativeFixtureCaseTimeoutMs
)
