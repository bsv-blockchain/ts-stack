import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { BulkHeaderSnapshotPublisher } from '../BulkHeaderSnapshotPublisher'

let root: string

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), 'bulk-snapshot-'))
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

test('publishes complete generations and preserves the last-good snapshot after failure', async () => {
  const publisher = new BulkHeaderSnapshotPublisher({ rootFolder: root, chain: 'main' })
  const firstData = new Uint8Array(80).fill(1)
  const first = await publisher.publish(async folder => await writeGeneration(folder, firstData))

  assert.equal(first.maxHeight, 0)
  assert.deepEqual(
    await fs.readFile(path.join(publisher.activeFolder, 'mainNet_0.headers')),
    Buffer.from(firstData)
  )
  const firstTarget = await fs.realpath(publisher.activeFolder)

  await assert.rejects(
    publisher.publish(async folder => {
      await writeGeneration(folder, new Uint8Array(80).fill(2))
      throw new Error('simulated crash before publish')
    }),
    /simulated crash/
  )

  assert.equal(await fs.realpath(publisher.activeFolder), firstTarget)
  assert.deepEqual(
    await fs.readFile(path.join(publisher.activeFolder, 'mainNet_0.headers')),
    Buffer.from(firstData)
  )

  await assert.rejects(
    publisher.publish(async folder => {
      await writeGeneration(folder, new Uint8Array(80).fill(3))
      await fs.writeFile(path.join(folder, 'mainNet_0.headers'), new Uint8Array(80).fill(4))
    }),
    /Invalid bulk-header snapshot digest/
  )
  assert.equal(await fs.realpath(publisher.activeFolder), firstTarget)
})

test('atomically advances the active pointer and retains bounded rollback generations', async () => {
  const publisher = new BulkHeaderSnapshotPublisher({
    rootFolder: root,
    chain: 'main',
    maxGenerations: 3
  })
  for (let value = 1; value <= 4; value++) {
    await publisher.publish(
      async folder => await writeGeneration(folder, new Uint8Array(80).fill(value))
    )
  }

  assert.deepEqual(
    await fs.readFile(path.join(publisher.activeFolder, 'mainNet_0.headers')),
    Buffer.from(new Uint8Array(80).fill(4))
  )
  const generations = (await fs.readdir(path.join(root, 'generations'))).filter(name =>
    name.startsWith('generation-')
  )
  assert.equal(generations.length, 3)
})

async function writeGeneration(folder: string, data: Uint8Array): Promise<void> {
  const fileName = 'mainNet_0.headers'
  await fs.writeFile(path.join(folder, fileName), data)
  await fs.writeFile(
    path.join(folder, 'mainNetBlockHeaders.json'),
    JSON.stringify({
      rootFolder: 'https://headers.example.test',
      jsonFilename: 'mainNetBlockHeaders.json',
      headersPerFile: 100000,
      files: [
        {
          chain: 'main',
          count: 1,
          fileHash: createHash('sha256').update(data).digest('base64'),
          fileName,
          firstHeight: 0,
          prevHash: '00'.repeat(32),
          prevChainWork: '00'.repeat(32),
          lastHash: '01'.repeat(32),
          lastChainWork: '01'.repeat(32)
        }
      ]
    })
  )
}
