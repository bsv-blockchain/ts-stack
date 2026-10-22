import fc from 'fast-check'
import { verifySnapshotArchiveDirectory, verifySnapshotArchivePage } from './SnapshotArchiveDirectory'
import { expected, fixture, hash, now, rehash, tables } from '../../../../test/utils/snapshotArchiveDirectoryFixtures'

const MIN_PROPERTY_RUNS = 300
const requestedRuns = Number.parseInt(process.env.FAST_CHECK_NUM_RUNS ?? '', 10)
const requestedSeed = Number.parseInt(process.env.FAST_CHECK_SEED ?? '', 10)
const replayPath = process.env.FAST_CHECK_PATH
fc.configureGlobal({
  numRuns: Number.isSafeInteger(requestedRuns) ? Math.max(MIN_PROPERTY_RUNS, requestedRuns) : MIN_PROPERTY_RUNS,
  ...(Number.isSafeInteger(requestedSeed) ? { seed: requestedSeed } : {}),
  ...(replayPath !== undefined && replayPath !== '' ? { path: replayPath } : {})
})

function generatedDirectory(pageCounts: number[], seed: Uint8Array) {
  const { directory } = fixture()
  const payloads: Uint8Array[] = []
  const ranges: Array<{ first: number; pages: number; rows: number }> = []
  directory.receipts = []
  directory.rows = 0
  for (const [tableIndex, table] of tables.entries()) {
    const range = { first: payloads.length, pages: pageCounts[tableIndex], rows: 0 }
    for (let page = 0; page < range.pages; page++) {
      const bytes = new Uint8Array([...seed, tableIndex, page])
      const done = page === range.pages - 1
      const rows = done ? seed[0] % 10 : 1 + seed[0]
      directory.receipts.push({ sequence: payloads.length, table, rows, done, digest: hash(bytes) })
      payloads.push(bytes)
      range.rows += rows
    }
    directory.rows += range.rows
    ranges.push(range)
  }
  directory.pages = payloads.length
  rehash(directory)
  return { directory, payloads, ranges }
}

test('generated receipt chains support arbitrary table reads while rejecting changed page and manifest bytes', () => {
  fc.assert(
    fc.property(
      fc.array(fc.integer({ min: 1, max: 4 }), { minLength: 13, maxLength: 13 }),
      fc.uint8Array({ minLength: 1, maxLength: 16 }),
      fc.integer({ min: 0, max: 1000 }),
      (pageCounts, seed, selection) => {
        const { directory, payloads, ranges } = generatedDirectory(pageCounts, seed)
        const verified = verifySnapshotArchiveDirectory(directory, { ...expected, digest: directory.digest }, now)
        expect(verified.manifest.rows).toBe(ranges.reduce((total, range) => total + range.rows, 0))
        for (const [index, table] of tables.entries()) expect(verified.tables[table]).toEqual(ranges[index])
        const selected = selection % payloads.length
        const original = payloads[selected]
        const page = { ...directory.receipts[selected], bytes: original }
        expect(verifySnapshotArchivePage(page, verified.receipts[selected])).toEqual(original)
        const changed = new Uint8Array(original)
        changed[0] ^= 1
        expect(() => verifySnapshotArchivePage({ ...page, bytes: changed }, verified.receipts[selected])).toThrow()
        directory.receipts[selected].digest = hash(changed)
        expect(() => verifySnapshotArchiveDirectory(directory, expected, now)).toThrow()
        rehash(directory)
        expect(() =>
          verifySnapshotArchiveDirectory(directory, { ...expected, digest: verified.manifest.digest }, now)
        ).toThrow()
        directory.receipts[selected].rows++
        expect(verified.receipts[selected].rows).toBe(page.rows)
      }
    )
  )
})
