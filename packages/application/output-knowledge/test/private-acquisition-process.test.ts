import { expect, it } from '@jest/globals'
import { fork } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { acquisitionStoreFixture } from './private-acquisition-store.fixture.js'

it.each(['quoted', 'pinned', 'funding-pending', 'funded', 'delivery-pending', 'delivered'])(
  'recovers the same original obligation after SIGKILL at %s',
  async phase => {
    const f = await acquisitionStoreFixture(),
      job = {
        path: f.path,
        configuration: f.configuration,
        installation: f.f.installation,
        ruleId: f.f.rules.id,
        limits: f.limits,
        policy: f.f.policy,
        original: f.original,
        phase,
        payment: f.f.f.payment(),
        sellerPaymentKey: f.f.f.sellerPaymentKey,
        acceptance: {
          chain: f.f.f.chain,
          txid: f.f.f.transaction.id('hex'),
          policy: { kind: 'local-admission' },
          acceptedAt: '19'
        }
      }
    const child = fork(
      fileURLToPath(new URL('./fixtures/private-acquisition-owner-worker.mjs', import.meta.url)),
      [],
      { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }
    )
    let output = ''
    child.stderr?.on('data', chunk => {
      output += String(chunk)
    })
    try {
      const result = await new Promise<{
        phase: string
        revision: string
        recordRevision: string
        state: unknown
      }>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Native acquisition fixture deadline: ' + output)),
          15000
        )
        child.once('message', value => {
          clearTimeout(timer)
          resolve(value as never)
        })
        child.once('error', error => {
          clearTimeout(timer)
          reject(error)
        })
        child.once('exit', (code, signal) => {
          clearTimeout(timer)
          reject(new Error(`Native fixture exited ${code}/${signal}: ${output}`))
        })
        child.send(job, error => {
          if (error) {
            clearTimeout(timer)
            reject(error)
          }
        })
      })
      expect(result.phase).toBe(phase)
      const exit = new Promise(resolve =>
        child.once('exit', (code, signal) => resolve({ code, signal }))
      )
      child.kill('SIGKILL')
      expect(await exit).toEqual({ code: null, signal: 'SIGKILL' })
      f.setNow('1000000')
      const reopened = f.open(),
        retained = reopened.store.load(f.id, f.buyer, f.clock, f.guard)!
      expect(retained.state).toEqual(result.state)
      expect(retained.revision).toBe(result.revision)
      expect(retained.row.revision).toBe(result.recordRevision)
      expect(retained.original).toEqual(f.original)
      expect(reopened.store.material(f.id, f.buyer, retained.row.revision, f.clock, f.guard)).toBe(
        'AQID'
      )
      if (phase === 'delivered') {
        let context: string | undefined
        reopened.store.disclose(retained, f.buyer, f.clock, f.guard, value => {
          context = value.result?.context
        })
        expect(context).toBe('BAUG')
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const ended = new Promise(resolve => child.once('exit', resolve))
        child.kill('SIGKILL')
        await ended
      }
    }
  },
  25000
)

it.each(['directory', 'filename', 'symlink', 'oversized'])(
  'refuses %s initialization before opening the acquisition worker database',
  async kind => {
    const outside = mkdtempSync(join(tmpdir(), 'unapproved-worker-')),
      disposable = mkdtempSync(join(tmpdir(), 'acquisition-store-')),
      file = join(outside, 'private.db')
    writeFileSync(file, 'Synthetic fixture only')
    let path = file
    if (kind === 'filename') {
      path = join(disposable, 'other.db')
      writeFileSync(path, 'Synthetic fixture only')
    } else if (kind === 'symlink') {
      path = join(disposable, 'private.db')
      symlinkSync(file, path)
    }
    const child = fork(
      fileURLToPath(new URL('./fixtures/private-acquisition-owner-worker.mjs', import.meta.url)),
      [],
      { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }
    )
    let output = ''
    child.stderr?.on('data', chunk => {
      output += String(chunk)
    })
    try {
      const exit = new Promise<number | null>((resolve, reject) => {
        child.once('error', reject)
        child.once('exit', resolve)
      })
      child.send({ path, ...(kind === 'oversized' ? { extra: 'x'.repeat(2097152) } : {}) })
      expect(await exit).toBe(1)
      expect(output).toContain(
        kind === 'oversized' ? 'Fixture job exceeds bound' : 'outside the disposable fixture'
      )
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const ended = new Promise(resolve => child.once('exit', resolve))
        child.kill('SIGKILL')
        await ended
      }
      rmSync(outside, { recursive: true, force: true })
      rmSync(disposable, { recursive: true, force: true })
    }
  },
  20000
)
