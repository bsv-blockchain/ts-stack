import { expect, it } from '@jest/globals'
import { fork, type ChildProcess } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { policy, selected } from './root-eviction-fixture.js'
import { localRule, localRulesFixture } from './root-eviction-local-rules-fixture.js'

async function kill(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const ended = new Promise<void>(resolve => child.once('exit', () => resolve()))
  child.kill('SIGKILL')
  await ended
}
for (const mode of ['before-invalidation', 'after-commit']) {
  it(`recovers the local-rule record, epoch, coverage and withdrawal coherently after process death ${mode}`, async () => {
    const f = await localRulesFixture()
    let child: ChildProcess | undefined
    try {
      await f.assess([])
      await f.project()
      const original = await f.store.head()
      const input = {
        operationId: f.nextId(),
        expectedRevision: original.revision,
        rule: localRule()
      }
      await writeFile(
        join(f.directory, 'worker.json'),
        JSON.stringify({ mode, input, configuration: f.configuration, policy })
      )
      child = fork(
        fileURLToPath(new URL('./fixtures/root-local-rules-worker.mjs', import.meta.url)),
        [],
        {
          cwd: f.directory,
          stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
          execArgv: []
        }
      )
      const worker = child
      const boundary = await new Promise<{ kind: string; decisionId?: string }>(
        (resolve, reject) => {
          let diagnostic = ''
          worker.stderr!.on('data', chunk => {
            diagnostic = (diagnostic + String(chunk)).slice(-4096)
          })
          worker.once('error', reject)
          worker.once('exit', code =>
            reject(new Error(`Local-rule worker exited before boundary: ${code}: ${diagnostic}`))
          )
          worker.once('message', message =>
            resolve(message as { kind: string; decisionId?: string })
          )
        }
      )
      expect(boundary.kind).toBe(mode === 'after-commit' ? 'committed' : mode)
      await kill(worker)
      const store = f.reopen(),
        rules = f.reopenRules()
      const active = await rules.active(f.guard)
      if (mode === 'before-invalidation') {
        expect(active.head).toEqual(original)
        expect(active.value).toEqual({ epoch: '0', rules: [] })
        expect((await store.serving(selected())).state).toBe('eligible')
        expect(await store.projections(64)).toEqual([])
      } else {
        expect(active.value.epoch).toBe('1')
        expect(active.value.rules.map(rule => rule.decisionId)).toEqual([boundary.decisionId])
        expect((await store.serving(selected())).state).toBe('unresolved')
        expect(await store.projections(64)).toMatchObject([{ membership: 'withdraw' }])
      }
      const recovered = await rules.install(input, f.guard)
      expect(recovered.value.rule).toEqual(input.rule)
      expect((await rules.active(f.guard)).value.rules).toHaveLength(1)
      expect((await store.serving(selected())).state).toBe('unresolved')
    } finally {
      if (child) await kill(child)
      await f.cleanup()
    }
  })
}
