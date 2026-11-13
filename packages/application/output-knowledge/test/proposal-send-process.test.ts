import { afterEach, expect, it } from '@jest/globals'
import { fork, type ChildProcess } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalOutputJSON } from '@bsv/sdk'
import { author, scope } from './proposal-fixture.js'
import { proposalSendFixture } from './proposal-send-fixture.js'

const fixtures: Awaited<ReturnType<typeof proposalSendFixture>>[] = []
const workers: ChildProcess[] = []
afterEach(async () => {
  for (const child of workers.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const ended = new Promise<void>(resolve => child.once('exit', () => resolve()))
      child.kill('SIGKILL')
      await ended
    }
  }
  await Promise.all(fixtures.splice(0).map(f => f.close()))
})

async function launch() {
  const f = await proposalSendFixture()
  fixtures.push(f)
  await writeFile(
    join(f.directory, 'worker.json'),
    JSON.stringify({
      file: f.file,
      scope,
      identity: author,
      reference: f.channel,
      record: canonicalOutputJSON(f.first.next)
    })
  )
  const child = fork(
    fileURLToPath(new URL('./fixtures/proposal-send-worker.mjs', import.meta.url)),
    [],
    {
      cwd: f.directory,
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      execArgv: []
    }
  )
  workers.push(child)
  const ready = new Promise<unknown>((resolve, reject) => {
    let diagnostic = ''
    child.stderr!.on('data', chunk => {
      diagnostic = (diagnostic + String(chunk)).slice(-4096)
    })
    child.once('error', reject)
    child.once('exit', code =>
      reject(new Error(`Proposal send worker exited: ${code}: ${diagnostic}`))
    )
    child.once('message', resolve)
  })
  expect(await ready).toEqual({ kind: 'enqueued', bytes: [1, 2, 3] })
  return { f, child }
}

it('holds an independent writer behind the actual native enqueue and releases it afterward', async () => {
  const { f, child } = await launch()
  await expect(f.store.commit(f.next)).rejects.toMatchObject({ code: 'ERR_SQLITE_ERROR' })
  const ended = new Promise<number | null>(resolve => child.once('exit', code => resolve(code)))
  await writeFile(join(f.directory, 'release'), '')
  expect(await ended).toBe(0)
  expect((await f.store.commit(f.next)).status).toBe('committed')
  expect((await f.store.getChannelEntry(f.channel.channelKey))?.transition.next).toEqual(
    f.next.next
  )
}, 30000)

it('recovers the original journal after process exit inside enqueue without inventing an undo', async () => {
  const { f, child } = await launch()
  const ended = new Promise<void>(resolve => child.once('exit', () => resolve()))
  child.kill('SIGKILL')
  await ended
  const reopened = f.open()
  expect((await reopened.head()).revision).toBe('1')
  expect((await reopened.getChannelEntry(f.channel.channelKey))?.transition.next).toEqual(
    f.first.next
  )
  expect((await reopened.commit(f.next)).status).toBe('committed')
}, 30000)
