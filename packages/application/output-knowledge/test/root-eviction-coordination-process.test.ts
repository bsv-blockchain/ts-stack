import { expect, it } from '@jest/globals'
import { fork, type ChildProcess } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { requester, signed, policy } from './root-eviction-fixture.js'
import { rootContractRules, rootContractTrust } from './root-contract-fixture.js'
import {
  coordinatedFixture,
  coordinatedRequest,
  contractSelection,
  coordinationGuard
} from './root-eviction-coordination-fixture.js'

async function kill(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const ended = new Promise<void>(resolve => child.once('exit', () => resolve()))
  child.kill('SIGKILL')
  await ended
}

for (const mode of ['before-contract-insert', 'after-commit']) {
  it(`recovers atomic request and capability state after a process kill ${mode}`, async () => {
    const f = await coordinatedFixture()
    let child: ChildProcess | undefined
    try {
      const body = coordinatedRequest(),
        selection = contractSelection(),
        trust = rootContractTrust()
      await writeFile(
        join(f.directory, 'worker.json'),
        JSON.stringify({
          mode,
          configuration: f.configuration,
          packet: signed(body),
          requester,
          policy,
          selection,
          trust: { ...trust, rules: undefined },
          rulesId: rootContractRules.id
        })
      )
      child = fork(
        fileURLToPath(new URL('./fixtures/root-coordination-worker.mjs', import.meta.url)),
        [],
        {
          cwd: f.directory,
          stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
          execArgv: []
        }
      )
      const worker = child
      const boundary = await new Promise<{ kind: string; digest?: string }>((resolve, reject) => {
        let diagnostic = ''
        worker.stderr!.on('data', chunk => {
          diagnostic += String(chunk)
        })
        worker.once('error', reject)
        worker.once('exit', code =>
          reject(new Error(`Coordination worker exited before boundary: ${code}: ${diagnostic}`))
        )
        worker.once('message', message => resolve(message as { kind: string; digest?: string }))
      })
      expect(boundary.kind).toBe(mode === 'after-commit' ? 'committed' : mode)
      await kill(worker)
      const reopened = f.reopen()
      if (mode === 'before-contract-insert') {
        expect(await reopened.get(requester, body.requestId)).toBeUndefined()
        await expect(
          reopened.resultCoordinated(
            requester,
            body.requestId,
            selection.selector,
            f.contracts,
            coordinationGuard()
          )
        ).rejects.toMatchObject({ code: 'not-found', message: expect.stringMatching(/\S/) })
        await reopened.retainCoordinated(
          signed(body),
          requester,
          selection,
          f.contracts,
          coordinationGuard()
        )
      }
      const status = await reopened.resultCoordinated(
        requester,
        body.requestId,
        selection.selector,
        f.contracts,
        coordinationGuard()
      )
      expect(status.value.retained.request.body).toEqual(body)
      expect(status.value.retained.contract.selection.digest).toBe(selection.selector)
      expect(status.value.result.outcomes[0].actionStatus).toBe('pending')
      if (mode === 'after-commit') expect(status.value.retained.digest).toBe(boundary.digest)
      expect((await reopened.head()).revision).toBe('0')
    } finally {
      if (child) await kill(child)
      await f.cleanup()
    }
  })
}
