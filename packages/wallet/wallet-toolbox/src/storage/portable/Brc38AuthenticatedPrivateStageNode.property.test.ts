import fc from 'fast-check'
import { appendFile, chmod, mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stageAuthenticatedBrc39PrivateImport } from './Brc38AuthenticatedPrivateStageNode'
import {
  authenticatedStagePassword,
  encrypted,
  authenticatedStageOptions
} from './Brc38AuthenticatedPrivateStageFixture'
import { Brc38StagingAdmissionNode, type Brc38StagingReservation } from './Brc38StagingAdmissionNode'
import { semanticStageFixture } from './Brc38SemanticStageFixture'
import { brc38StageTables } from './Brc38SemanticStage'

const MIN_PROPERTY_RUNS = 300
fc.configureGlobal({
  numRuns: Math.max(
    MIN_PROPERTY_RUNS,
    Number(process.env.FAST_CHECK_NUM_RUNS ?? process.env.FC_NUM_RUNS ?? MIN_PROPERTY_RUNS)
  ),
  seed: Number(process.env.FAST_CHECK_SEED ?? process.env.FC_SEED ?? 3242026)
})
// The complete 300-run campaign may use its 150-second property allowance;
// leave another 30 seconds for original physical-owner cleanup. Each import
// keeps its own original reservation deadline, including authenticated replay.
const propertyCaseMilliseconds = 180000
const controls = {
  interruptAfterTimeLimit: 150000,
  markInterruptAsFailure: true,
  path: process.env.FAST_CHECK_PATH ?? process.env.FC_PATH ?? ''
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'brc38-property-authenticated-stage-'))
  await chmod(directory, 0o700)
  if (process.env.TMPDIR === '/work/fixtures')
    await appendFile('/work/validation/fixture-record.jsonl', JSON.stringify({ path: directory }) + '\n')
  const root = await Brc38StagingAdmissionNode.create(directory, {
    maximumImports: 1,
    maximumPhysicalBytes: 7340032,
    maximumLogicalBytes: 1048576
  })
  const held: Brc38StagingReservation[] = [],
    admit = root.admit.bind(root),
    resume = root.resume.bind(root)
  // Observe actual returned owners. Both methods execute their original body;
  // no store, binding, authentication receipt or capability is supplied by a mock.
  const admissionObserver = jest.spyOn(root, 'admit').mockImplementation(async (...args) => {
    const value = await admit(...args)
    held.push(value)
    return value
  })
  const resumeObserver = jest.spyOn(root, 'resume').mockImplementation(async (...args) => {
    const value = await resume(...args)
    held.push(value)
    return value
  })
  return {
    directory,
    root,
    held,
    empty: async () => {
      expect((await root.usage()).imports).toBe(0)
      expect(await readdir(directory)).toEqual(['brc38-admission.sqlite'])
    },
    close: async () => {
      admissionObserver.mockRestore()
      resumeObserver.mockRestore()
      for (const value of held) await value.store.close()
      await root.close()
      await rm(directory, { recursive: true, force: true })
    }
  }
}

async function* partition(bytes: Uint8Array, widths: readonly number[], emptyEvery: number) {
  let position = 0,
    index = 0
  while (position < bytes.length) {
    if (emptyEvery !== 0 && index % emptyEvery === 0) yield new Uint8Array()
    const end = Math.min(bytes.length, position + widths[index % widths.length])
    yield bytes.slice(position, end)
    position = end
    index++
  }
}

describe('actual complete authenticated private staging lifecycle', () => {
  test(
    'generated independent envelopes and partitions preserve all thirteen rows and original charged replay',
    async () => {
      const target = await fixture()
      try {
        await fc.assert(
          fc.asyncProperty(
            fc.record({
              widths: fc.array(fc.integer({ min: 32, max: 1024 }), { minLength: 1, maxLength: 8 }),
              emptyEvery: fc.integer({ min: 0, max: 7 }),
              nfc: fc.boolean(),
              description: fc.array(fc.constantFrom('x', 'é', '中', '😀', '"', '\\'), {
                maxLength: 12
              })
            }),
            async generated => {
              const expected = semanticStageFixture()
              Object.assign(expected.tables.transactions[0], {
                description: 'case-' + generated.description.join('')
              })
              // Independent array AEAD/Argon2id writer; production streaming reader
              // authenticates the original supported historical-import envelope.
              const bytes = await encrypted(expected),
                selected = authenticatedStageOptions(bytes),
                before = JSON.stringify(selected)
              let checkedBeforeAuthentication = false,
                sourceSettled = false
              async function* source() {
                try {
                  yield* partition(bytes, generated.widths, generated.emptyEvery)
                  const owner = target.held.at(-1)!
                  expect(await owner.store.knex('metadata').where({ slot: 1 }).first('state')).toEqual({
                    state: 'staging'
                  })
                  expect((await target.root.usage()).imports).toBe(1)
                  checkedBeforeAuthentication = true
                } finally {
                  sourceSettled = true
                }
              }
              const value = await stageAuthenticatedBrc39PrivateImport(
                source(),
                generated.nfc ? authenticatedStagePassword.normalize('NFC') : authenticatedStagePassword,
                target.root,
                selected
              )
              expect(checkedBeforeAuthentication && sourceSettled).toBe(true)
              expect(value.archiveSha256).toBe(selected.binding.archiveSha256)
              expect(value.fileBytes).toBe(bytes.length)
              expect(value.plaintextBytes).toBe(Buffer.byteLength(JSON.stringify(expected)))
              expect(Object.values(value.document.counts)).toEqual(Array(13).fill(1))
              for (const table of brc38StageTables) {
                expect(await value.reservation.store.count(table)).toBe(1)
                expect(await value.reservation.store.row(table, 0)).toEqual(expected.tables[table][0])
              }
              const metadata = await value.reservation.store.knex('metadata').where({ slot: 1 }).first()
              expect(metadata.state).toBe('sealed')
              expect((await stat(value.reservation.store.directory)).mode & 0o777).toBe(0o700)
              expect((await stat(join(value.reservation.store.directory, 'stage.sqlite'))).mode & 0o777).toBe(0o600)
              await value.reservation.store.close()
              const replay = await stageAuthenticatedBrc39PrivateImport(
                partition(bytes, [...generated.widths].reverse(), generated.emptyEvery),
                authenticatedStagePassword,
                target.root,
                { ...selected, reservationId: value.reservation.id }
              )
              expect(replay.reservation.id).toBe(value.reservation.id)
              expect(replay.document).toEqual(value.document)
              expect(replay.reservation.store.limits.expiresAt).toBe(selected.limits.expiresAt)
              expect(await replay.reservation.store.knex('metadata').where({ slot: 1 }).first()).toEqual(metadata)
              expect((await target.root.usage()).imports).toBe(1)
              expect(JSON.stringify(selected)).toBe(before)
              await target.root.discard(replay.reservation, new Error('completed synthetic generated import'))
              await target.empty()
            }
          ),
          controls
        )
      } finally {
        await target.close()
      }
    },
    propertyCaseMilliseconds
  )

  test(
    'generated ordinary authentication and semantic refusals release physical capacity before rejection',
    async () => {
      const target = await fixture(),
        valid = await encrypted()
      try {
        await fc.assert(
          fc.asyncProperty(
            fc.constantFrom('tag', 'password', 'digest', 'truncated', 'relation'),
            fc.integer({ min: 32, max: 1024 }),
            async (kind, width) => {
              let bytes: Uint8Array = valid.slice()
              if (kind === 'relation') {
                const data = semanticStageFixture()
                data.tables.outputs[0].transactionId = 999
                bytes = await encrypted(data)
              }
              if (kind === 'tag') bytes[bytes.length - 1] ^= 1
              if (kind === 'truncated') bytes = bytes.slice(0, -1)
              const selected = authenticatedStageOptions(bytes)
              if (kind === 'digest') selected.binding = { ...selected.binding, archiveSha256: 'a'.repeat(64) }
              let sourceSettled = false
              async function* source() {
                try {
                  yield* partition(bytes, [width], 0)
                } finally {
                  sourceSettled = true
                }
              }
              await expect(
                stageAuthenticatedBrc39PrivateImport(
                  source(),
                  kind === 'password' ? 'different synthetic password' : authenticatedStagePassword,
                  target.root,
                  selected
                )
              ).rejects.toThrow()
              expect(sourceSettled).toBe(true)
              await target.empty()
            }
          ),
          controls
        )
      } finally {
        await target.close()
      }
    },
    propertyCaseMilliseconds
  )

  test(
    'generated source failure, cancellation and pre-admission refusal retain exact reasons and settle original ownership',
    async () => {
      const target = await fixture(),
        bytes = await encrypted()
      try {
        await fc.assert(
          fc.asyncProperty(
            fc.constantFrom('source', 'cancel', 'pre-abort', 'policy'),
            fc.integer({ min: 1, max: bytes.length - 1 }),
            async (kind, position) => {
              const reason = new Error('synthetic generated staging stop ' + position),
                controller = new AbortController(),
                selected = authenticatedStageOptions(bytes),
                heldBefore = target.held.length
              selected.crypto.signal = controller.signal
              if (kind === 'pre-abort') controller.abort(reason)
              if (kind === 'policy') selected.maximumMetadataAllocationBytes = 65537
              let entered = false,
                settled = false
              async function* source() {
                entered = true
                try {
                  yield* partition(bytes.slice(0, position), [137], 0)
                  if (kind === 'cancel') {
                    controller.abort(reason)
                    yield new Uint8Array()
                  } else throw reason
                } finally {
                  settled = true
                }
              }
              const work = stageAuthenticatedBrc39PrivateImport(
                source(),
                authenticatedStagePassword,
                target.root,
                selected
              )
              if (kind === 'policy') await expect(work).rejects.toThrow('policy')
              else await expect(work).rejects.toBe(reason)
              if (kind === 'policy' || kind === 'pre-abort') {
                expect(entered).toBe(false)
                expect(target.held.length).toBe(heldBefore)
              } else expect(entered && settled).toBe(true)
              await target.empty()
            }
          ),
          controls
        )
      } finally {
        await target.close()
      }
    },
    propertyCaseMilliseconds
  )
})
