import { chmod, mkdtemp, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import * as portable from './stream'
import * as native from './node'
import { decryptBRC39, parseBRC38Json, type BRC38Tables } from './index'
import { jsonStreamFixture } from './Brc38JsonStreamFixture'

test('public entries preserve all thirteen tables through authenticated private file staging', async () => {
  const data = jsonStreamFixture()
  const maximumChunkBytes = 64
  const maximumFileBytes = 65536
  // Only this small, explicitly bounded synthetic oracle is materialized.
  const expected = Buffer.concat([
    ...portable.canonicalPortableChunks(data, { maximumValueBytes: maximumFileBytes, maximumChunkBytes })
  ])
  expect(parseBRC38Json(expected.toString('utf8'))).toEqual(data)
  const events: string[] = []
  const visited: (keyof BRC38Tables)[] = []
  const source = await portable.createBrc38Stream(
    {
      sourceStorage: data.sourceStorage,
      user: data.user,
      async *rows(table) {
        visited.push(table)
        yield* data.tables[table]
      },
      validateCompleted() {
        expect(visited).toHaveLength(13)
        expect(new Set(visited)).toEqual(new Set(Object.keys(data.tables)))
        expect(parseBRC38Json(JSON.stringify(data))).toEqual(data)
        events.push('source validated')
        return Promise.resolve()
      },
      release() {
        events.push('source released')
        return Promise.resolve()
      }
    },
    { exportedAt: data.exportedAt, maximumArchiveBytes: maximumFileBytes, maximumRowBytes: 4096, maximumChunkBytes }
  )
  const encrypted: Uint8Array[] = []
  const password = 'Cafe\u0301 private fixture'
  const policy = {
    maximumFileBytes,
    maximumChunkBytes,
    maximumIterations: 7,
    maximumMemoryKiB: 131072,
    maximumParallelism: 1
  }
  const options = { policy, maximumPasswordBytes: 1024 }
  const exported = await native.encryptBrc39StreamToQuarantine(
    source,
    password,
    {
      appendUntrusted(bytes) {
        expect(bytes.length).toBeLessThanOrEqual(maximumChunkBytes)
        encrypted.push(bytes.slice())
        events.push(`write ${bytes.length}`)
        return Promise.resolve()
      },
      discard() {
        encrypted.length = 0
        return Promise.resolve()
      }
    },
    options
  )
  expect(exported.plaintextBytes).toBe(expected.length)
  expect(events.filter(event => event === 'source released')).toHaveLength(1)
  expect(events.slice(-3)).toEqual(['source validated', 'source released', 'write 16'])
  const ciphertext = Buffer.concat(encrypted)
  expect(exported.fileBytes).toBe(ciphertext.length)
  expect(await decryptBRC39(ciphertext, password.normalize('NFC'))).toEqual(data)

  const parent = await mkdtemp(join(tmpdir(), 'ts-stack-entry-points-'))
  let stage: native.Brc39NodeFileQuarantine | undefined
  let validated = 0
  const staged: BRC38Tables = {
    provenTxs: [],
    provenTxReqs: [],
    outputBaskets: [],
    transactions: [],
    commissions: [],
    outputs: [],
    outputTags: [],
    outputTagMaps: [],
    txLabels: [],
    txLabelMaps: [],
    certificates: [],
    certificateFields: [],
    syncStates: []
  }
  try {
    await chmod(parent, 0o700)
    stage = await native.createBrc39NodeFileQuarantine(
      parent,
      async chunks => {
        const parsed = await portable.readBrc38JsonStream(
          chunks,
          {
            provisionalRow(table, index, row) {
              expect(index).toBe(0)
              expect(staged[table]).toHaveLength(0)
              expect(row).toEqual(data.tables[table][index])
              ;(staged[table] as unknown[]).push(row)
              return Promise.resolve()
            },
            validateCompleted(header, counts) {
              expect(new Set(Object.keys(counts))).toEqual(new Set(Object.keys(data.tables)))
              expect(Object.values(counts)).toEqual(Array(13).fill(1))
              expect(parseBRC38Json(JSON.stringify({ ...header, tables: staged }))).toEqual(data)
              return Promise.resolve()
            },
            discard() {
              for (const rows of Object.values(staged)) rows.length = 0
              return Promise.resolve()
            }
          },
          {
            maximumArchiveBytes: maximumFileBytes,
            maximumRowAllocationBytes: 4096,
            maximumInputChunkBytes: maximumChunkBytes
          }
        )
        expect(parsed.inputBytes).toBe(expected.length)
        validated++
      },
      { maximumFileBytes, maximumChunkBytes }
    )
    await expect(stage.withAuthenticatedChunks(() => Promise.resolve(undefined))).rejects.toThrow(
      'has not been validated'
    )
    async function* ciphertextChunks() {
      yield* encrypted
    }
    const imported = await native.decryptBrc39StreamToQuarantine(ciphertextChunks(), password, stage, options)
    expect(imported).toEqual(exported)
    expect(validated).toBe(1)
    expect(staged).toEqual(data.tables)
    await stage.withAuthenticatedChunks(async chunks => {
      const actual: Uint8Array[] = []
      for await (const bytes of chunks) {
        expect(bytes.length).toBeLessThanOrEqual(maximumChunkBytes)
        actual.push(bytes)
      }
      expect(Buffer.concat(actual)).toEqual(expected)
    })
    await stage.discard()
    expect(await readdir(parent)).toEqual([])
  } finally {
    try {
      await stage?.discard()
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  }
})
