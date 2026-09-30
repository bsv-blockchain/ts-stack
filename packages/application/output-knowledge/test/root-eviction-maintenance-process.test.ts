import { expect, it, jest } from '@jest/globals'
import { fork, type ChildProcess } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SQLiteRootEvictionMaintenance } from '../src/root-eviction/SQLiteRootEvictionMaintenance.js'
import { fixture, requester, signed, clock } from './root-eviction-fixture.js'

async function kill(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const ended = new Promise<void>(resolve => child.once('exit', () => resolve()))
  child.kill('SIGKILL')
  await ended
}

for (const mode of ['before-terminal-insert', 'after-commit']) {
  it(`recovers pending expiry atomically after an actual process kill ${mode}`, async () => {
    const f = await fixture()
    let child: ChildProcess | undefined
    try {
      const retained = await f.store.retain(signed(), requester, clock)
      await writeFile(
        join(f.directory, 'worker.json'),
        JSON.stringify({ mode, configuration: f.configuration, digest: retained.digest })
      )
      child = fork(
        fileURLToPath(new URL('./fixtures/root-maintenance-worker.mjs', import.meta.url)),
        [],
        {
          cwd: f.directory,
          stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
          execArgv: []
        }
      )
      const worker = child
      const boundary = await new Promise<{ kind: string }>((resolve, reject) => {
        let diagnostic = ''
        worker.stderr!.on('data', chunk => {
          diagnostic += String(chunk)
        })
        worker.once('error', reject)
        worker.once('exit', code =>
          reject(new Error(`Maintenance worker exited before boundary: ${code}: ${diagnostic}`))
        )
        worker.once('message', message => resolve(message as { kind: string }))
      })
      expect(boundary.kind).toBe(mode === 'after-commit' ? 'committed' : mode)
      await kill(worker)
      const restarted = SQLiteRootEvictionMaintenance.open(f.path, f.configuration)
      try {
        const guard = { clock: () => '200', authorize: () => true }
        expect((await f.store.head()).revision).toBe(mode === 'after-commit' ? '1' : '0')
        expect((await restarted.pendingPage({ maximum: 1 }, guard)).value.digests).toEqual(
          mode === 'after-commit' ? [] : [retained.digest]
        )
        expect(
          (await restarted.expirePending(retained.digest, guard)).value.expiredTargets
        ).toEqual(mode === 'after-commit' ? [] : [0])
        expect((await f.store.head()).revision).toBe('1')
        expect(await f.store.get(requester, retained.request.body.requestId)).toEqual(retained)
        expect(
          (await f.store.result(requester, retained.request.body.requestId, '201')).outcomes[0]
        ).toMatchObject({ actionStatus: 'rejected', reasonCode: 'request-expired', revision: '1' })
      } finally {
        await restarted.close()
      }
    } finally {
      if (child) await kill(child)
      await f.cleanup()
    }
  })
}

it('samples expiry time only after an independent writer releases the root gate', async () => {
  const f = await fixture(),
    worker = SQLiteRootEvictionMaintenance.open(f.path, f.configuration)
  let child: ChildProcess | undefined
  try {
    const retained = await f.store.retain(signed(), requester, clock)
    child = fork(
      fileURLToPath(new URL('./fixtures/root-commit-lock-worker.mjs', import.meta.url)),
      [],
      {
        cwd: f.directory,
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        execArgv: []
      }
    )
    const holder = child
    const ended = new Promise<void>(resolve => holder.once('exit', () => resolve()))
    await new Promise<void>((resolve, reject) => {
      holder.once('message', () => resolve())
      holder.once('error', reject)
      holder.once('exit', code =>
        reject(new Error(`Maintenance gate holder exited early: ${code}`))
      )
    })
    const started = performance.now()
    const sample = jest.fn(() => (performance.now() - started >= 100 ? '200' : '199'))
    holder.send('release-after-wait')
    const result = await worker.expirePending(retained.digest, {
      clock: sample,
      authorize: () => true
    })
    expect(sample).toHaveBeenCalledTimes(1)
    expect(result.observedAt).toBe('200')
    expect(result.value).toEqual({ expiredTargets: [0], pendingTargets: [] })
    await ended
    expect(holder.exitCode).toBe(0)
  } finally {
    if (child) await kill(child)
    await worker.close()
    await f.cleanup()
  }
}, 15000)
