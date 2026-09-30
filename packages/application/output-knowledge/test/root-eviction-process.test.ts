import { afterEach, describe, expect, it } from '@jest/globals'
import { fork, type ChildProcess } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  apply,
  clock,
  fixture,
  request,
  requester,
  restore,
  selected,
  signed
} from './root-eviction-fixture.js'

const fixtures: Awaited<ReturnType<typeof fixture>>[] = []
const workers: ChildProcess[] = []
async function make() {
  const f = await fixture()
  fixtures.push(f)
  return f
}
afterEach(async () => {
  for (const child of workers.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const ended = new Promise<void>(resolve => child.once('exit', () => resolve()))
      child.kill('SIGKILL')
      await ended
    }
  }
  for (const f of fixtures.splice(0)) await f.cleanup()
})
async function launch(f: Awaited<ReturnType<typeof fixture>>, setup: Record<string, unknown>) {
  const settings = join(f.directory, 'worker.json')
  await writeFile(
    settings,
    JSON.stringify({ path: f.path, configuration: f.configuration, ...setup })
  )
  const child = fork(
    fileURLToPath(new URL('./fixtures/root-eviction-worker.mjs', import.meta.url)),
    [settings],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], execArgv: [] }
  )
  workers.push(child)
  const boundary = new Promise<{ kind: string; bytes?: number[] }>((resolve, reject) => {
    let diagnostic = ''
    child.stderr!.on('data', chunk => {
      diagnostic += String(chunk)
    })
    child.once('error', reject)
    child.once('exit', code =>
      reject(new Error(`Root worker exited before its boundary: ${code}: ${diagnostic}`))
    )
    child.once('message', message => resolve(message as { kind: string; bytes?: number[] }))
  })
  return { child, boundary }
}
async function kill(child: ChildProcess) {
  const ended = new Promise<void>(resolve => child.once('exit', () => resolve()))
  child.kill('SIGKILL')
  await ended
}

describe('root journal process boundaries', () => {
  it('retains the suppression fence and index-removal intent after an actual process kill', async () => {
    const f = await make(),
      body = request()
    const retained = await f.store.retain(signed(body), requester, clock)
    const { child, boundary } = await launch(f, {
      mode: 'decision',
      evaluation: {
        requestDigest: retained.digest,
        expectedRevision: '0',
        now: '150',
        targets: [
          { index: 0, disposition: 'accept', reasonCode: 'fixture-approved', eligible: true }
        ]
      }
    })
    expect(await boundary).toEqual({ kind: 'committed' })
    await kill(child)
    const reopened = f.reopen()
    expect((await reopened.result(requester, body.requestId, '151')).outcomes[0]).toMatchObject({
      actionStatus: 'applied',
      revision: '1',
      serving: { state: 'suppressed' }
    })
    expect(await reopened.projections(1)).toEqual([
      { target: selected(), revision: '1', membership: 'withdraw' }
    ])
  })

  it('recovers an acknowledged restoration without repeating its membership effect after a process kill', async () => {
    const f = await make()
    const first = await apply(f.store)
    await apply(f.store, restore('fixture_restore_process', first.outcomes[0].decisionId!))
    const [intent] = await f.store.projections(1)
    const { child, boundary } = await launch(f, { mode: 'projection', intent })
    expect(await boundary).toEqual({ kind: 'committed' })
    await kill(child)
    const reopened = f.reopen(),
      head = await reopened.head()
    expect((await reopened.serving(selected())).state).toBe('eligible')
    expect(await reopened.projected(intent)).toBe(true)
    expect(await reopened.head()).toEqual(head)
    expect(await reopened.projections(1)).toEqual([])
  })

  it('keeps a separate writer behind the actual final enqueue fence and rejects stale responses afterward', async () => {
    const f = await make()
    await f.store.assess({
      operationId: 'fixture_queue_assessment',
      expectedRevision: '0',
      target: selected(),
      eligible: true,
      evidenceDigest: '77'.repeat(32),
      reasonCode: 'fixture-current'
    })
    await f.store.projected((await f.store.projections(1))[0])
    const revision = (await f.store.head()).revision,
      body = request()
    const retained = await f.store.retain(signed(body), requester, clock)
    const release = join(f.directory, 'release-gate')
    const { child, boundary } = await launch(f, {
      mode: 'queue',
      revision,
      target: selected(),
      release
    })
    expect(await boundary).toEqual({ kind: 'queued', bytes: [1, 2, 3] })
    const evaluation = {
      requestDigest: retained.digest,
      expectedRevision: revision,
      now: '150',
      targets: [
        { index: 0, disposition: 'accept' as const, reasonCode: 'fixture-approved', eligible: true }
      ]
    }
    await expect(f.store.evaluate(evaluation)).rejects.toMatchObject({
      code: 'unavailable',
      retryable: true
    })
    const ended = new Promise<void>(resolve => child.once('exit', () => resolve()))
    await writeFile(release, '')
    await ended
    expect(child.exitCode).toBe(0)
    await f.store.evaluate(evaluation)
    let sent = false
    await expect(
      f.store.enqueue(
        { revision, targets: [selected()], bytes: new Uint8Array([4]) },
        () => true,
        () => {
          sent = true
        }
      )
    ).rejects.toMatchObject({ code: 'reset-required', message: expect.stringMatching(/\S/) })
    expect(sent).toBe(false)
    expect((await f.store.serving(selected())).state).toBe('suppressed')
  }, 15000)
})
