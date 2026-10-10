import { fork, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { resolve } from 'node:path'
import { _tu } from '../../../../test/utils/TestUtilsWalletStorage'
import { SQLiteFundingRecoveryStore } from '../../../storage/fundingRecovery/SQLiteFundingRecoveryStore'
import { fundingFixture } from '../../../storage/fundingRecovery/__tests__/fundingFixture'
import type { FundingRecoveryResult } from '../../../storage/fundingRecovery/FundingRecoveryProtocol'

interface Message {
  event: 'boundary' | 'recovered' | 'error'
  stage?: string
  before?: FundingRecoveryResult
  result?: FundingRecoveryResult
  again?: FundingRecoveryResult
  outputs?: number
  satoshis?: number
  message?: string
}

function receive(child: ChildProcess): Promise<Message> {
  return new Promise((resolveMessage, reject) => {
    const timer = setTimeout(() => finish(new Error('Funding process fixture deadline exceeded')), 20000)
    const onExit = () => finish(new Error('Funding process fixture exited before reporting'))
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

test.each(['intent-before-commit', 'intent-after-commit', 'ownership-before-commit', 'receipt-before-commit', 'receipt-after-commit'])('recovers one credit after SIGKILL at %s', async stage => {
  const context = await _tu.createLegacyWalletSQLiteCopy(`funding-process-${stage}`, 'legacy')
  const { chain, operation, source } = fundingFixture(context)
  await SQLiteFundingRecoveryStore.install(context.activeStorage, chain)
  const input = { database: context.activeStorage.knex.client.config.connection.filename as string, fixtureKey: context.rootKey.toHex(), chain, operation: operation(), root: source.id('hex') }
  await context.wallet.destroy()
  const worker = resolve(__dirname, 'fixtures/crash-worker.cjs')
  const first = fork(worker, [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  let second: ChildProcess | undefined
  try {
    const boundary = receive(first)
    first.send({ ...input, mode: 'interrupt', stage })
    expect(await boundary).toEqual({ event: 'boundary', stage })
    await stop(first)
    second = fork(worker, [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
    const recovery = receive(second)
    second.send({ ...input, mode: 'recover' })
    const recovered = await recovery
    expect(recovered.event).toBe('recovered')
    expect(recovered.before?.state).toBe(stage === 'intent-before-commit' ? 'absent' : stage === 'receipt-after-commit' ? 'accepted' : 'unknown')
    expect(recovered.result).toMatchObject({ state: 'accepted', funding: input.operation.funding, receipt: { operationId: input.operation.id, satoshis: '100' } })
    expect(recovered.again).toEqual(recovered.result)
    expect(recovered.outputs).toBe(1)
    expect(recovered.satoshis).toBe(100)
  } finally {
    await stop(first)
    if (second !== undefined) await stop(second)
  }
}, 30000)

test('two independent wallet processes racing the same intent commit one credit and identical receipts', async () => {
  const context = await _tu.createLegacyWalletSQLiteCopy('funding-independent-process-race', 'legacy')
  const { chain, operation, source } = fundingFixture(context)
  await SQLiteFundingRecoveryStore.install(context.activeStorage, chain)
  const input = { database: context.activeStorage.knex.client.config.connection.filename as string, fixtureKey: context.rootKey.toHex(), chain, operation: operation(), root: source.id('hex'), mode: 'race' }
  await context.wallet.destroy()
  const worker = resolve(__dirname, 'fixtures/crash-worker.cjs')
  const children = [fork(worker, [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }), fork(worker, [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })]
  try {
    const ready = children.map(receive)
    for (const child of children) child.send(input)
    expect(await Promise.all(ready)).toEqual([{ event: 'boundary', stage: 'ready-to-credit' }, { event: 'boundary', stage: 'ready-to-credit' }])
    const results = children.map(receive)
    for (const child of children) child.send({ proceed: true })
    const completed = await Promise.all(results)
    expect(completed[0].result).toMatchObject({ state: 'accepted', funding: input.operation.funding })
    expect(completed[1].result).toEqual(completed[0].result)
    for (const child of children) await stop(child)
    const recovery = fork(worker, [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
    children.push(recovery)
    const final = receive(recovery)
    recovery.send({ ...input, mode: 'recover' })
    expect(await final).toMatchObject({ event: 'recovered', outputs: 1, satoshis: 100, result: completed[0].result })
  } finally {
    for (const child of children) await stop(child)
  }
}, 30000)
