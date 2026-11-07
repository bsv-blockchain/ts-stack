import { fork, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { resolve } from 'node:path'
import { Transaction, type CreateActionArgs } from '@bsv/sdk'
import { _tu } from '../../../../test/utils/TestUtilsWalletStorage'
import { SQLiteActionRecoveryStore } from '../../../storage/actionRecovery/SQLiteActionRecoveryStore'
import type { RecoveredAction } from '../RecoverableActionController'

interface Message {
  event: 'boundary' | 'recovered' | 'error'
  stage?: string
  reference?: string
  txid?: string
  tx?: number[]
  rawTx?: number[]
  result?: RecoveredAction
  records?: number
  message?: string
}

function receive(child: ChildProcess): Promise<Message> {
  return new Promise((resolveMessage, reject) => {
    const timer = setTimeout(() => finish(new Error('Recovery fixture deadline exceeded')), 20000)
    const onExit = () => finish(new Error('Recovery fixture exited before reporting'))
    const onMessage = (message: Message) => finish(message.event === 'error' ? new Error(message.message) : undefined, message)
    function finish(error?: Error, message?: Message) {
      clearTimeout(timer)
      child.off('exit', onExit)
      child.off('message', onMessage)
      if (error !== undefined) reject(error)
      else resolveMessage(message!)
    }
    child.once('exit', onExit)
    child.once('message', onMessage)
  })
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, 'exit')
  child.kill('SIGKILL')
  await exited
}

it.each([
  'allocation-before-commit', 'allocation-after-commit', 'prepared-before-response',
  'final-before-processing', 'processed-before-response'
])('recovers after process termination at %s using the same SQLite wallet', async stage => {
  const context = await _tu.createLegacyWalletSQLiteCopy(`recovery-process-${stage}`, 'legacy')
  await SQLiteActionRecoveryStore.install(context.activeStorage)
  const database = context.activeStorage.knex.client.config.connection.filename as string
  const fixtureKey = context.rootKey.toHex()
  await context.wallet.destroy()
  const request: CreateActionArgs = {
    description: 'Process recovery fixture',
    outputs: [{ lockingScript: '51', satoshis: 10, outputDescription: 'Synthetic process output' }],
    options: { noSend: true, signAndProcess: false, randomizeOutputs: false, returnTXIDOnly: false }
  }
  const worker = resolve(__dirname, 'fixtures/crash-worker.cjs')
  const first = fork(worker, [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  let second: ChildProcess | undefined
  try {
    const boundary = receive(first)
    first.send({ mode: 'interrupt', stage, database, fixtureKey, request })
    const original = await boundary
    expect(original.event).toBe('boundary')
    expect(original.stage).toBe(stage)
    await stop(first)
    second = fork(worker, [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
    const recovery = receive(second)
    second.send({ mode: 'recover', database, fixtureKey, request, requireNoSigning: stage.startsWith('final') || stage.startsWith('processed') })
    const recovered = await recovery
    expect(recovered.event).toBe('recovered')
    const result = recovered.result!
    if (stage === 'allocation-before-commit') {
      expect(result).toEqual({ state: 'absent' })
      expect(recovered.records).toBe(0)
    } else if (stage.startsWith('allocation') || stage.startsWith('prepared')) {
      expect(result.state).toBe('prepared')
      if (result.state !== 'prepared') throw new Error('Expected prepared action')
      expect(result.result.signableTransaction!.reference).toBe(original.reference)
      if (original.tx !== undefined) expect(result.result.signableTransaction!.tx).toEqual(original.tx)
      expect(recovered.records).toBe(1)
    } else {
      expect(result.state).toBe('finalized')
      if (result.state !== 'finalized') throw new Error('Expected finalized action')
      expect(result.result.txid).toBe(original.txid)
      if (original.tx !== undefined) expect(result.result.tx).toEqual(original.tx)
      if (original.rawTx !== undefined) expect(Transaction.fromAtomicBEEF(result.result.tx!).toHex()).toBe(Buffer.from(original.rawTx).toString('hex'))
    }
  } finally {
    await stop(first)
    if (second !== undefined) await stop(second)
  }
}, 30000)
