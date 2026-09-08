import ChainTracker from '../ChainTracker'
import MerklePath from '../MerklePath'
import Transaction from '../Transaction'
import { TransactionEvidenceError } from '../TransactionEvidence'
import { TransactionEvidenceCoordinator } from '../TransactionEvidenceCoordinator'
import type BdkVerifierInterface from '../BdkVerifierInterface'
import type { BdkVerifyScriptsParams } from '../BdkVerifierInterface'
import P2PKH from '../../script/templates/P2PKH'
import PrivateKey from '../../primitives/PrivateKey'
import Script from '../../script/Script'
import Spend from '../../script/Spend'
import ScriptResourceLimitError from '../../script/ScriptResourceLimitError'

const height = 700_000

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

class LocalChainTracker implements ChainTracker {
  readonly roots = new Set<string>()
  readonly calls: Array<{ root: string; height: number }> = []
  context = 0
  current = height + 101
  gate: Promise<void> | undefined
  onRootCall: (() => void) | undefined
  aborts = 0

  async currentHeight(): Promise<number> {
    return this.current
  }

  async isValidRootForHeight(
    root: string,
    blockHeight: number,
    signal?: AbortSignal
  ): Promise<boolean> {
    this.calls.push({ root, height: blockHeight })
    this.onRootCall?.()
    if (signal != null)
      signal.addEventListener(
        'abort',
        () => {
          this.aborts++
        },
        { once: true }
      )
    if (this.gate !== undefined) await this.gate
    if (signal?.aborted === true) throw new TransactionEvidenceError('cancelled')
    return blockHeight === height && this.roots.has(root)
  }

  getVerificationContext(): number {
    return this.context
  }
}

class TokenChainTracker extends LocalChainTracker {
  readonly rootsByHeight = new Map<number, Set<string>>()
  readonly rootChecks = new Map<number, number>()
  token = 'tip-a'
  tokenGate: Promise<void> | undefined
  tokenCalls = 0
  tokenAborts = 0
  tokenFailure: Error | undefined
  onAnchorCheck: ((height: number, count: number) => void) | undefined

  addRoot(root: string, blockHeight: number): void {
    const roots = this.rootsByHeight.get(blockHeight) ?? new Set<string>()
    roots.add(root)
    this.rootsByHeight.set(blockHeight, roots)
  }

  removeRoot(root: string, blockHeight: number): void {
    this.rootsByHeight.get(blockHeight)?.delete(root)
  }

  async isValidRootForHeight(
    root: string,
    blockHeight: number,
    signal?: AbortSignal
  ): Promise<boolean> {
    this.calls.push({ root, height: blockHeight })
    this.onRootCall?.()
    if (signal != null)
      signal.addEventListener(
        'abort',
        () => {
          this.aborts++
        },
        { once: true }
      )
    if (this.gate !== undefined) await this.gate
    if (signal?.aborted === true) throw new TransactionEvidenceError('cancelled')
    const count = (this.rootChecks.get(blockHeight) ?? 0) + 1
    this.rootChecks.set(blockHeight, count)
    const valid = this.rootsByHeight.get(blockHeight)?.has(root) === true
    this.onAnchorCheck?.(blockHeight, count)
    return valid
  }

  async getVerificationContextToken(signal?: AbortSignal): Promise<string> {
    this.tokenCalls++
    if (signal != null)
      signal.addEventListener(
        'abort',
        () => {
          this.tokenAborts++
        },
        { once: true }
      )
    if (this.tokenGate !== undefined) await this.tokenGate
    if (signal?.aborted === true) throw new TransactionEvidenceError('cancelled')
    if (this.tokenFailure !== undefined) throw this.tokenFailure
    return this.token
  }
}

async function fixture(): Promise<{
  tracker: LocalChainTracker
  tx: Transaction
  evidence: number[]
}> {
  const key = new PrivateKey(42)
  const p2pkh = new P2PKH()
  const tracker = new LocalChainTracker()
  const source = new Transaction()
  source.addInput({
    sourceTXID: '00'.repeat(32),
    sourceOutputIndex: 0,
    unlockingScript: Script.fromASM('OP_TRUE')
  })
  source.addOutput({ satoshis: 10, lockingScript: p2pkh.lock(key.toAddress()) })
  source.merklePath = new MerklePath(height, [
    [
      { offset: 0, hash: source.id('hex'), txid: true },
      { offset: 1, duplicate: true }
    ]
  ])
  tracker.roots.add(source.merklePath.computeRoot(source.id('hex')))

  const tx = new Transaction()
  tx.addInput({
    sourceTransaction: source,
    sourceOutputIndex: 0,
    unlockingScriptTemplate: p2pkh.unlock(key)
  })
  tx.addOutput({ satoshis: 4, lockingScript: p2pkh.lock(key.toAddress()) })
  tx.addOutput({ satoshis: 4, lockingScript: p2pkh.lock(key.toAddress()) })
  await tx.sign()
  return { tracker, tx, evidence: tx.toBEEF() }
}

async function sharedAncestorFixture(): Promise<{
  tracker: LocalChainTracker
  ancestor: Transaction
  first: Transaction
  second: Transaction
  firstEvidence: number[]
  secondEvidence: number[]
}> {
  const key = new PrivateKey(43)
  const p2pkh = new P2PKH()
  const tracker = new LocalChainTracker()
  const confirmed = new Transaction()
  confirmed.addInput({
    sourceTXID: '00'.repeat(32),
    sourceOutputIndex: 0,
    unlockingScript: Script.fromASM('OP_TRUE')
  })
  confirmed.addOutput({ satoshis: 20, lockingScript: p2pkh.lock(key.toAddress()) })
  confirmed.merklePath = new MerklePath(height, [
    [
      { offset: 0, hash: confirmed.id('hex'), txid: true },
      { offset: 1, duplicate: true }
    ]
  ])
  tracker.roots.add(confirmed.merklePath.computeRoot(confirmed.id('hex')))

  const ancestor = new Transaction()
  ancestor.addInput({
    sourceTransaction: confirmed,
    sourceOutputIndex: 0,
    unlockingScriptTemplate: p2pkh.unlock(key)
  })
  ancestor.addOutput({ satoshis: 9, lockingScript: p2pkh.lock(key.toAddress()) })
  ancestor.addOutput({ satoshis: 9, lockingScript: p2pkh.lock(key.toAddress()) })
  await ancestor.sign()

  const createChild = async (outputIndex: number): Promise<Transaction> => {
    const child = new Transaction()
    child.addInput({
      sourceTransaction: ancestor,
      sourceOutputIndex: outputIndex,
      unlockingScriptTemplate: p2pkh.unlock(key)
    })
    child.addOutput({ satoshis: 8, lockingScript: p2pkh.lock(key.toAddress()) })
    await child.sign()
    return child
  }
  const first = await createChild(0)
  const second = await createChild(1)
  return {
    tracker,
    ancestor,
    first,
    second,
    firstEvidence: first.toBEEF(),
    secondEvidence: second.toBEEF()
  }
}

async function twoAnchorFixture(): Promise<{
  tracker: TokenChainTracker
  tx: Transaction
  evidence: number[]
  roots: string[]
}> {
  const key = new PrivateKey(44)
  const p2pkh = new P2PKH()
  const tracker = new TokenChainTracker()
  const roots: string[] = []
  const sources: Transaction[] = []
  for (const blockHeight of [200, 100]) {
    const source = new Transaction()
    source.addInput({
      sourceTXID: blockHeight.toString(16).padStart(64, '0'),
      sourceOutputIndex: 0,
      unlockingScript: Script.fromASM('OP_TRUE')
    })
    source.addOutput({ satoshis: 10, lockingScript: p2pkh.lock(key.toAddress()) })
    source.merklePath = new MerklePath(blockHeight, [
      [
        { offset: 0, hash: source.id('hex'), txid: true },
        { offset: 1, duplicate: true }
      ]
    ])
    const root = source.merklePath.computeRoot(source.id('hex'))
    tracker.addRoot(root, blockHeight)
    roots.push(root)
    sources.push(source)
  }
  const tx = new Transaction()
  for (const source of sources) {
    tx.addInput({
      sourceTransaction: source,
      sourceOutputIndex: 0,
      unlockingScriptTemplate: p2pkh.unlock(key)
    })
  }
  tx.addOutput({ satoshis: 18, lockingScript: p2pkh.lock(key.toAddress()) })
  await tx.sign()
  return { tracker, tx, evidence: tx.toBEEF(), roots }
}

function verifyParamsInJavaScript(params: BdkVerifyScriptsParams): boolean {
  const sigHashCache = { hashOutputsSingle: new Map() }
  for (const [inputIndex, input] of params.tx.inputs.entries()) {
    const source = input.sourceTransaction
    const sourceOutput = source?.outputs[input.sourceOutputIndex]
    if (source === undefined || sourceOutput === undefined || input.unlockingScript === undefined)
      return false
    const valid = new Spend({
      sourceTXID: input.sourceTXID ?? source.id('hex'),
      sourceOutputIndex: input.sourceOutputIndex,
      lockingScript: sourceOutput.lockingScript,
      sourceSatoshis: sourceOutput.satoshis ?? 0,
      transactionVersion: params.tx.version,
      otherInputs: [],
      allInputs: params.tx.inputs,
      unlockingScript: input.unlockingScript,
      inputSequence: input.sequence ?? 0xffffffff,
      inputIndex,
      outputs: params.tx.outputs,
      lockTime: params.tx.lockTime,
      memoryLimit: params.memoryLimit,
      sigHashCache
    }).validateJavaScript()
    if (!valid) return false
  }
  return true
}

function alternateReceipt(evidence: number[], marker: number): number[] {
  const alternate = Transaction.fromBEEF(evidence)
  const source = alternate.inputs[0].sourceTransaction
  if (source === undefined) throw new Error('fixture source is missing')
  source.merklePath = new MerklePath(height, [
    [
      { offset: 0, hash: source.id('hex'), txid: true },
      { offset: 1, hash: marker.toString(16).padStart(64, '0') }
    ]
  ])
  return alternate.toBEEF()
}

function coordinator(
  tracker: LocalChainTracker,
  limits = {},
  verifier?: BdkVerifierInterface
): TransactionEvidenceCoordinator {
  return new TransactionEvidenceCoordinator({
    chainTracker: tracker,
    chainNamespace: 'local-canonical-chain',
    policyId: 'p2pkh-consensus',
    limits,
    verifier
  })
}

async function expectCode(
  promise: Promise<unknown>,
  code: TransactionEvidenceError['code']
): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code })
}

describe('TransactionEvidenceCoordinator', () => {
  it('coalesces concurrent output requests for one signed transaction into one full verification', async () => {
    const { tracker, tx, evidence } = await fixture()
    const verify = jest.spyOn(Transaction.prototype, 'verify')
    const verifier: BdkVerifierInterface = {
      supportsMemoryLimit: true,
      verifyScripts: jest.fn(async () => true)
    }
    const subject = coordinator(tracker, {}, verifier)

    const [first, second] = await Promise.all([
      subject.verify({ beef: evidence, outputIndex: 0, txid: tx.id('hex') }),
      subject.verify({ beef: evidence, outputIndex: 1, txid: tx.id('hex') })
    ])

    expect(first).toMatchObject({
      txid: tx.id('hex'),
      outputIndex: 0,
      outpoint: `${tx.id('hex')}.0`
    })
    expect(second).toMatchObject({
      txid: tx.id('hex'),
      outputIndex: 1,
      outpoint: `${tx.id('hex')}.1`
    })
    expect(first.lockingScript.toHex()).toBe(tx.outputs[0].lockingScript.toHex())
    expect(tracker.calls).toContainEqual({ root: [...tracker.roots][0], height })
    expect(verify).toHaveBeenCalledTimes(1)
    expect(verifier.verifyScripts).toHaveBeenCalledTimes(1)
    expect(subject.getStats()).toMatchObject({
      pendingTransactions: 0,
      consumers: 0,
      activeAttempts: 0
    })
    verify.mockRestore()
  })

  it('does not permanently poison a transaction key after an invalid canonical root', async () => {
    const { tracker, tx, evidence } = await fixture()
    const root = [...tracker.roots][0]
    tracker.roots.clear()
    const subject = coordinator(tracker)

    await expectCode(subject.verify({ beef: evidence, outputIndex: 0 }), 'invalid-evidence')
    tracker.roots.add(root)
    await expect(subject.verify({ beef: evidence, outputIndex: 0 })).resolves.toMatchObject({
      txid: tx.id('hex')
    })
  })

  it('retains a distinct same-target receipt when a later proof repairs an earlier failed root', async () => {
    const { tracker, evidence } = await fixture()
    const alternate = Transaction.fromBEEF(evidence)
    const source = alternate.inputs[0].sourceTransaction
    if (source === undefined) throw new Error('fixture source is missing')
    source.merklePath = new MerklePath(height, [
      [
        { offset: 0, hash: source.id('hex'), txid: true },
        { offset: 1, hash: '42'.repeat(32) }
      ]
    ])
    tracker.roots.clear()
    tracker.roots.add(source.merklePath.computeRoot(source.id('hex')))
    const subject = coordinator(tracker)

    const [fromBadReceipt, fromGoodReceipt] = await Promise.all([
      subject.verify({ beef: evidence, outputIndex: 0 }),
      subject.verify({ beef: alternate.toBEEF(), outputIndex: 1 })
    ])

    expect(fromBadReceipt).toMatchObject({ outputIndex: 0 })
    expect(fromGoodReceipt).toMatchObject({ outputIndex: 1 })
  })

  it('lets one consumer cancel while a coalesced consumer still receives the verified output', async () => {
    const { tracker, evidence } = await fixture()
    const release = deferred<void>()
    tracker.gate = release.promise
    const subject = coordinator(tracker)
    const abort = new AbortController()
    const entered = deferred<void>()
    tracker.onRootCall = () => entered.resolve()
    const cancelled = subject.verify({ beef: evidence, outputIndex: 0 }, { signal: abort.signal })
    const successful = subject.verify({ beef: evidence, outputIndex: 1 })

    await entered.promise
    abort.abort()
    await expectCode(cancelled, 'cancelled')
    // The shared chain call still has a live owner, so this cancellation cannot abort it.
    expect(tracker.aborts).toBe(0)
    release.resolve()
    await expect(successful).resolves.toMatchObject({ outputIndex: 1 })
  })

  it('aborts the last owner, leaves no late cache publication, and counts non-abortable work until it settles', async () => {
    const { tracker, evidence } = await fixture()
    const release = deferred<void>()
    tracker.gate = release.promise
    const subject = coordinator(tracker)
    const abort = new AbortController()
    const entered = deferred<void>()
    tracker.onRootCall = () => entered.resolve()
    const request = subject.verify({ beef: evidence, outputIndex: 0 }, { signal: abort.signal })

    await entered.promise
    abort.abort()
    await expectCode(request, 'cancelled')
    expect(tracker.aborts).toBe(1)
    expect(subject.getStats().pendingChainCalls).toBe(1)
    release.resolve()
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(subject.getStats()).toMatchObject({
      cachedTransactions: 0,
      pendingChainCalls: 0,
      activeAttempts: 0
    })
  })

  it('fences in-flight and cached work when namespace or policy context changes', async () => {
    const { tracker, evidence } = await fixture()
    const release = deferred<void>()
    tracker.gate = release.promise
    const subject = coordinator(tracker)
    const previous = subject.verify({ beef: evidence, outputIndex: 0 })

    subject.setContext({
      chainTracker: tracker,
      chainNamespace: 'replacement-chain',
      policyId: 'replacement-policy'
    })
    await expectCode(previous, 'context-changed')
    release.resolve()
    await expect(subject.verify({ beef: evidence, outputIndex: 0 })).resolves.toMatchObject({
      outputIndex: 0
    })
  })

  it('rechecks cached canonical dependencies on a reorganization and retains a valid cache at a new tip', async () => {
    const { tracker, evidence } = await fixture()
    const root = [...tracker.roots][0]
    const verify = jest.spyOn(Transaction.prototype, 'verify')
    const verifier: BdkVerifierInterface = {
      supportsMemoryLimit: true,
      verifyScripts: jest.fn(async () => true)
    }
    const subject = coordinator(tracker, {}, verifier)

    await subject.verify({ beef: evidence, outputIndex: 0 })
    expect(verify).toHaveBeenCalledTimes(1)
    expect(verifier.verifyScripts).toHaveBeenCalledTimes(1)
    tracker.current++
    await expect(subject.verify({ beef: evidence, outputIndex: 0 })).resolves.toMatchObject({
      outputIndex: 0
    })
    expect(verify).toHaveBeenCalledTimes(1)
    expect(verifier.verifyScripts).toHaveBeenCalledTimes(1)
    tracker.roots.clear()
    await expectCode(subject.verify({ beef: evidence, outputIndex: 0 }), 'invalid-evidence')
    expect(verify).toHaveBeenCalledTimes(2)
    // The rejected canonical dependency stops before target script execution.
    expect(verifier.verifyScripts).toHaveBeenCalledTimes(1)
    expect(tracker.calls).toContainEqual({ root, height })
    verify.mockRestore()
  })

  it('times out an attempt without poisoning a later valid receipt', async () => {
    jest.useFakeTimers()
    try {
      const { tracker, evidence } = await fixture()
      const release = deferred<void>()
      const entered = deferred<void>()
      tracker.gate = release.promise
      tracker.onRootCall = () => entered.resolve()
      const subject = coordinator(tracker, { attemptTimeoutMs: 10, requestTimeoutMs: 100 })
      const timedOut = subject.verify({ beef: evidence, outputIndex: 0 })

      await entered.promise
      await jest.advanceTimersByTimeAsync(11)
      await expectCode(timedOut, 'timeout')
      release.resolve()
      await jest.runOnlyPendingTimersAsync()
      tracker.gate = undefined
      await expect(subject.verify({ beef: evidence, outputIndex: 0 })).resolves.toMatchObject({
        outputIndex: 0
      })
    } finally {
      jest.useRealTimers()
    }
  })

  it('drops an in-flight result when the tracker changes its verification context', async () => {
    const { tracker, evidence } = await fixture()
    const release = deferred<void>()
    tracker.gate = release.promise
    const subject = coordinator(tracker)
    const request = subject.verify({ beef: evidence, outputIndex: 0 })

    tracker.context++
    release.resolve()
    await expectCode(request, 'context-changed')
    expect(subject.getStats().cachedTransactions).toBe(0)
  })

  it('snapshots bytes before deriving its key and rejects a mismatched txid hint', async () => {
    const { tracker, tx, evidence } = await fixture()
    const subject = coordinator(tracker)
    const mutable = evidence.slice()
    const request = subject.verify({ beef: mutable, outputIndex: 0, txid: tx.id('hex') })
    mutable.fill(0)
    await expect(request).resolves.toMatchObject({ txid: tx.id('hex') })
    await expectCode(
      subject.verify({ beef: evidence, outputIndex: 0, txid: '00'.repeat(32) }),
      'invalid-evidence'
    )
  })

  it('enforces finite admission, consumer, and cache-expiry limits', async () => {
    const { tracker, evidence } = await fixture()
    const tooSmall = coordinator(tracker, { candidateBytes: 1 })
    await expectCode(tooSmall.verify({ beef: evidence, outputIndex: 0 }), 'limit')

    const gate = deferred<void>()
    tracker.gate = gate.promise
    const oneConsumer = coordinator(tracker, { consumers: 1 })
    const first = oneConsumer.verify({ beef: evidence, outputIndex: 0 })
    await expectCode(oneConsumer.verify({ beef: evidence, outputIndex: 1 }), 'limit')
    gate.resolve()
    await expect(first).resolves.toMatchObject({ outputIndex: 0 })

    jest.useFakeTimers()
    try {
      const verify = jest.spyOn(Transaction.prototype, 'verify')
      const expiring = coordinator(tracker, { cacheAgeMs: 1 })
      await expiring.verify({ beef: evidence, outputIndex: 0 })
      await jest.advanceTimersByTimeAsync(2)
      await expiring.verify({ beef: evidence, outputIndex: 0 })
      expect(verify).toHaveBeenCalledTimes(2)
      verify.mockRestore()
    } finally {
      jest.useRealTimers()
    }
  })

  it('keeps a successful shared ancestor when a sibling non-batch script execution rejects', async () => {
    const { tracker, ancestor, first, second, firstEvidence, secondEvidence } =
      await sharedAncestorFixture()
    const entered = deferred<void>()
    const release = deferred<void>()
    const verifier: BdkVerifierInterface = {
      supportsMemoryLimit: true,
      verifyScripts: async params => {
        if (params.tx.id('hex') === ancestor.id('hex')) {
          entered.resolve()
          await release.promise
          return true
        }
        if (params.tx.id('hex') === first.id('hex')) {
          throw new ScriptResourceLimitError('stack', 1, 2)
        }
        return verifyParamsInJavaScript(params)
      }
    }
    const subject = coordinator(tracker, {}, verifier)
    const failed = subject.verify({ beef: firstEvidence, outputIndex: 0 })
    await entered.promise
    const succeeded = subject.verify({ beef: secondEvidence, outputIndex: 0 })
    release.resolve()

    await expectCode(failed, 'limit')
    await expect(succeeded).resolves.toMatchObject({
      txid: second.id('hex'),
      outputIndex: 0
    })
  })

  it('rejects every created batch entry when the backend batch call itself fails', async () => {
    const { tracker, firstEvidence, secondEvidence } = await sharedAncestorFixture()
    const entered = deferred<void>()
    const release = deferred<void>()
    const verifier: BdkVerifierInterface = {
      supportsMemoryLimit: true,
      verifyScripts: async () => true,
      verifyScriptsBatch: async () => {
        entered.resolve()
        await release.promise
        throw new ScriptResourceLimitError('stack', 1, 2)
      }
    }
    const subject = coordinator(tracker, {}, verifier)
    const first = subject.verify({ beef: firstEvidence, outputIndex: 0 })
    await entered.promise
    const second = subject.verify({ beef: secondEvidence, outputIndex: 0 })
    release.resolve()

    await expectCode(first, 'limit')
    await expectCode(second, 'limit')
  })

  it('runs a signed shared ancestor once while each distinct child still validates its own input', async () => {
    const { tracker, first, second, firstEvidence, secondEvidence } = await sharedAncestorFixture()
    const validate = jest.spyOn(Spend.prototype, 'validateJavaScript')
    const subject = coordinator(tracker)

    await Promise.all([
      subject.verify({ beef: firstEvidence, outputIndex: 0 }),
      subject.verify({ beef: secondEvidence, outputIndex: 0 })
    ])

    expect(first.id('hex')).not.toBe(second.id('hex'))
    expect(validate).toHaveBeenCalledTimes(3)
    validate.mockRestore()
  })

  it('preserves backend batches while sharing the in-flight signed ancestor exactly once', async () => {
    const { tracker, ancestor, first, second, firstEvidence, secondEvidence } =
      await sharedAncestorFixture()
    const validate = jest.spyOn(Spend.prototype, 'validateJavaScript')
    const verifyScripts = jest.fn(async () => {
      throw new Error('batch path required')
    })
    const verifyScriptsBatch = jest.fn(async (params: readonly BdkVerifyScriptsParams[]) =>
      params.map(verifyParamsInJavaScript)
    )
    const verifier: BdkVerifierInterface = {
      supportsMemoryLimit: true,
      verifyScripts,
      verifyScriptsBatch
    }
    const subject = coordinator(tracker, {}, verifier)

    await Promise.all([
      subject.verify({ beef: firstEvidence, outputIndex: 0 }),
      subject.verify({ beef: secondEvidence, outputIndex: 0 })
    ])

    const submitted = verifyScriptsBatch.mock.calls.flatMap(([params]) =>
      params.map(param => param.tx.id('hex'))
    )
    expect(verifyScripts).not.toHaveBeenCalled()
    expect(verifyScriptsBatch.mock.calls.some(([params]) => params.length > 1)).toBe(true)
    expect(submitted.filter(txid => txid === ancestor.id('hex'))).toHaveLength(1)
    expect(submitted).toEqual(expect.arrayContaining([first.id('hex'), second.id('hex')]))
    expect(validate).toHaveBeenCalledTimes(3)
    validate.mockRestore()
  })

  it('keeps a shared ancestor alive when one distinct-target owner cancels', async () => {
    const { tracker, ancestor, firstEvidence, secondEvidence } = await sharedAncestorFixture()
    const entered = deferred<void>()
    const release = deferred<void>()
    const batches: string[][] = []
    const verifier: BdkVerifierInterface = {
      supportsMemoryLimit: true,
      verifyScripts: async () => false,
      verifyScriptsBatch: async params => {
        batches.push(params.map(param => param.tx.id('hex')))
        entered.resolve()
        await release.promise
        return params.map(verifyParamsInJavaScript)
      }
    }
    const subject = coordinator(tracker, {}, verifier)
    const abort = new AbortController()
    const cancelled = subject.verify(
      { beef: firstEvidence, outputIndex: 0 },
      { signal: abort.signal }
    )
    const successful = subject.verify({ beef: secondEvidence, outputIndex: 0 })

    await entered.promise
    abort.abort()
    await expectCode(cancelled, 'cancelled')
    release.resolve()
    await expect(successful).resolves.toMatchObject({ outputIndex: 0 })
    expect(batches.flat().filter(txid => txid === ancestor.id('hex'))).toHaveLength(1)
  })

  it('does not publish a late backend completion across a policy context change', async () => {
    const { tracker, firstEvidence } = await sharedAncestorFixture()
    const entered = deferred<void>()
    const release = deferred<void>()
    const verifier: BdkVerifierInterface = {
      supportsMemoryLimit: true,
      verifyScripts: async () => false,
      verifyScriptsBatch: async params => {
        entered.resolve()
        await release.promise
        return params.map(verifyParamsInJavaScript)
      }
    }
    const subject = coordinator(tracker, {}, verifier)
    const request = subject.verify({ beef: firstEvidence, outputIndex: 0 })

    await entered.promise
    subject.setContext({
      chainTracker: tracker,
      chainNamespace: 'local-canonical-chain',
      policyId: 'replacement-policy',
      verifier
    })
    await expectCode(request, 'context-changed')
    release.resolve()
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(subject.getStats()).toMatchObject({ cachedTransactions: 0, activeAttempts: 0 })
    await expect(subject.verify({ beef: firstEvidence, outputIndex: 0 })).resolves.toMatchObject({
      outputIndex: 0
    })
  })

  it('rejects backend mutation of an owned verification parameter and accepts a later clean receipt', async () => {
    const { tracker, firstEvidence } = await sharedAncestorFixture()
    const entered = deferred<void>()
    const release = deferred<void>()
    let mutate = true
    const verifier: BdkVerifierInterface = {
      supportsMemoryLimit: true,
      verifyScripts: async () => false,
      verifyScriptsBatch: async params => {
        entered.resolve()
        await release.promise
        if (mutate) {
          const source = params[0].tx.inputs[0].sourceTransaction
          if (source === undefined) throw new Error('fixture source is missing')
          source.outputs[0].satoshis++
        }
        return params.map(verifyParamsInJavaScript)
      }
    }
    const subject = coordinator(tracker, {}, verifier)
    const mutated = subject.verify({ beef: firstEvidence, outputIndex: 0 })

    await entered.promise
    release.resolve()
    await expectCode(mutated, 'invalid-evidence')
    mutate = false
    await expect(subject.verify({ beef: firstEvidence, outputIndex: 0 })).resolves.toMatchObject({
      outputIndex: 0
    })
  })

  it('does not free a non-abortable backend slot until its cancelled work actually settles', async () => {
    const { tracker, firstEvidence, secondEvidence } = await sharedAncestorFixture()
    const entered = deferred<void>()
    const release = deferred<void>()
    let calls = 0
    const verifier: BdkVerifierInterface = {
      supportsMemoryLimit: true,
      verifyScripts: async () => false,
      verifyScriptsBatch: async params => {
        calls++
        entered.resolve()
        await release.promise
        return params.map(verifyParamsInJavaScript)
      }
    }
    const subject = coordinator(tracker, { concurrentTransactions: 1 }, verifier)
    const abort = new AbortController()
    const cancelled = subject.verify(
      { beef: firstEvidence, outputIndex: 0 },
      { signal: abort.signal }
    )

    await entered.promise
    abort.abort()
    await expectCode(cancelled, 'cancelled')
    const pending = subject.verify({ beef: secondEvidence, outputIndex: 0 })
    expect(subject.getStats()).toMatchObject({ pendingTransactions: 1, activeAttempts: 1 })
    expect(calls).toBe(1)
    release.resolve()
    await expect(pending).resolves.toMatchObject({ outputIndex: 0 })
    expect(calls).toBeGreaterThanOrEqual(2)
  })

  it('preflights approved duplicate and conflicting ancestry before warmed script work can be reused', async () => {
    const { tracker, ancestor, firstEvidence, secondEvidence } = await sharedAncestorFixture()
    const confirmed = ancestor.inputs[0].sourceTransaction
    if (confirmed === undefined) throw new Error('fixture root is missing')
    const key = new PrivateKey(43)
    const p2pkh = new P2PKH()
    const subject = coordinator(tracker)
    const verify = jest.spyOn(Transaction.prototype, 'verify')
    const validate = jest.spyOn(Spend.prototype, 'validateJavaScript')
    await subject.verify({ beef: firstEvidence, outputIndex: 0 })
    const warmedVerifyCalls = verify.mock.calls.length
    const warmedScriptCalls = validate.mock.calls.length

    const duplicate = new Transaction()
    for (let index = 0; index < 2; index++) {
      duplicate.addInput({
        sourceTransaction: confirmed,
        sourceOutputIndex: 0,
        unlockingScriptTemplate: p2pkh.unlock(key)
      })
    }
    duplicate.addOutput({ satoshis: 19, lockingScript: p2pkh.lock(key.toAddress()) })
    await duplicate.sign()

    const createConflictingParent = async (satoshis: number): Promise<Transaction> => {
      const parent = new Transaction()
      parent.addInput({
        sourceTransaction: confirmed,
        sourceOutputIndex: 0,
        unlockingScriptTemplate: p2pkh.unlock(key)
      })
      parent.addOutput({ satoshis, lockingScript: p2pkh.lock(key.toAddress()) })
      await parent.sign()
      return parent
    }
    const left = await createConflictingParent(9)
    const right = await createConflictingParent(8)
    const joined = new Transaction()
    for (const sourceTransaction of [left, right]) {
      joined.addInput({
        sourceTransaction,
        sourceOutputIndex: 0,
        unlockingScriptTemplate: p2pkh.unlock(key)
      })
    }
    joined.addOutput({ satoshis: 15, lockingScript: p2pkh.lock(key.toAddress()) })
    await joined.sign()

    await expectCode(
      subject.verify({ beef: duplicate.toBEEF(), outputIndex: 0 }),
      'invalid-evidence'
    )
    await expectCode(subject.verify({ beef: joined.toBEEF(), outputIndex: 0 }), 'invalid-evidence')
    expect(verify).toHaveBeenCalledTimes(warmedVerifyCalls)
    expect(validate).toHaveBeenCalledTimes(warmedScriptCalls)
    await subject.verify({ beef: secondEvidence, outputIndex: 0 })
    expect(validate).toHaveBeenCalledTimes(warmedScriptCalls + 1)
    verify.mockRestore()
    validate.mockRestore()
  })

  it('rejects changed source bytes before a warmed target cache can be selected by a txid hint', async () => {
    const { tracker, tx, evidence } = await fixture()
    const subject = coordinator(tracker)
    const verify = jest.spyOn(Transaction.prototype, 'verify')
    await subject.verify({ beef: evidence, outputIndex: 0 })
    const altered = Transaction.fromBEEF(evidence)
    const source = altered.inputs[0].sourceTransaction
    if (source === undefined) throw new Error('fixture source is missing')
    source.outputs[0].satoshis++

    await expectCode(
      subject.verify({ beef: altered.toBEEF(), outputIndex: 0, txid: tx.id('hex') }),
      'invalid-evidence'
    )
    expect(verify).toHaveBeenCalledTimes(1)
    await subject.verify({ beef: evidence, outputIndex: 0, txid: tx.id('hex') })
    expect(verify).toHaveBeenCalledTimes(1)
    verify.mockRestore()
  })

  it('bounds candidates, complete graph shape, pending chain calls, and independent contexts', async () => {
    const { tracker, evidence } = await fixture()
    await expectCode(
      coordinator(tracker, { transactions: 1 }).verify({ beef: evidence, outputIndex: 0 }),
      'limit'
    )
    await expectCode(
      coordinator(tracker, { inputs: 1 }).verify({ beef: evidence, outputIndex: 0 }),
      'limit'
    )
    await expectCode(
      coordinator(tracker, { scriptBytes: 1 }).verify({ beef: evidence, outputIndex: 0 }),
      'limit'
    )

    const release = deferred<void>()
    const entered = deferred<void>()
    tracker.gate = release.promise
    tracker.onRootCall = () => entered.resolve()
    const candidateLimited = coordinator(tracker, { candidatesPerTransaction: 8 })
    const controllers = Array.from({ length: 8 }, () => new AbortController())
    const requests = controllers.map((controller, index) =>
      candidateLimited.verify(
        { beef: index === 0 ? evidence : alternateReceipt(evidence, index), outputIndex: 0 },
        { signal: controller.signal }
      )
    )
    await entered.promise
    await expectCode(
      candidateLimited.verify({ beef: alternateReceipt(evidence, 9), outputIndex: 0 }),
      'limit'
    )
    controllers.forEach(controller => controller.abort())
    await Promise.all(requests.map(async request => await expectCode(request, 'cancelled')))
    release.resolve()

    const second = await sharedAncestorFixture()
    for (const root of second.tracker.roots) tracker.roots.add(root)
    const chainRelease = deferred<void>()
    const chainEntered = deferred<void>()
    tracker.gate = chainRelease.promise
    tracker.onRootCall = () => chainEntered.resolve()
    const chainLimited = coordinator(tracker, { pendingChainCalls: 1 })
    const firstRequest = chainLimited.verify({ beef: evidence, outputIndex: 0 })
    await chainEntered.promise
    await expectCode(chainLimited.verify({ beef: second.firstEvidence, outputIndex: 0 }), 'limit')
    expect(chainLimited.getStats().pendingChainCalls).toBe(1)
    chainRelease.resolve()
    await expect(firstRequest).resolves.toMatchObject({ outputIndex: 0 })

    const contexts = coordinator(tracker)
    const contextVerify = jest.spyOn(Transaction.prototype, 'verify')
    await contexts.verify({ beef: evidence, outputIndex: 0 })
    const replacement = new LocalChainTracker()
    for (const root of tracker.roots) replacement.roots.add(root)
    contexts.setContext({
      chainTracker: replacement,
      chainNamespace: 'independent-network',
      policyId: 'independent-policy'
    })
    await contexts.verify({ beef: evidence, outputIndex: 0 })
    expect(contextVerify).toHaveBeenCalledTimes(2)
    contextVerify.mockRestore()
  })

  it('rejects a two-height result when its token changes after the final H200 check and before H100 completes', async () => {
    const { tracker, evidence, roots } = await twoAnchorFixture()
    tracker.onAnchorCheck = (blockHeight, count) => {
      if (blockHeight === 200 && count === 2) {
        tracker.removeRoot(roots[0], 200)
        tracker.token = 'tip-b'
      }
    }
    const subject = coordinator(tracker)

    await expectCode(subject.verify({ beef: evidence, outputIndex: 0 }), 'context-changed')
    expect(tracker.rootChecks.get(200)).toBe(2)
    expect(tracker.rootChecks.get(100)).toBe(2)
    expect(subject.getStats().cachedTransactions).toBe(0)
  })

  it('rejects an in-flight same-height root when the trusted token changes', async () => {
    const { tracker, evidence } = await twoAnchorFixture()
    const release = deferred<void>()
    const entered = deferred<void>()
    tracker.gate = release.promise
    tracker.onRootCall = () => entered.resolve()
    const subject = coordinator(tracker)
    const request = subject.verify({ beef: evidence, outputIndex: 0 })

    await entered.promise
    tracker.token = 'tip-b'
    release.resolve()
    await expectCode(request, 'context-changed')
    expect(subject.getStats().cachedTransactions).toBe(0)
  })

  it('keeps cached crypto work when a new canonical tip is already stable before the read begins', async () => {
    const { tracker, evidence } = await twoAnchorFixture()
    const verify = jest.spyOn(Transaction.prototype, 'verify')
    const subject = coordinator(tracker)

    await subject.verify({ beef: evidence, outputIndex: 0 })
    tracker.token = 'tip-b'
    await expect(subject.verify({ beef: evidence, outputIndex: 0 })).resolves.toMatchObject({
      outputIndex: 0
    })
    expect(verify).toHaveBeenCalledTimes(1)
    expect(tracker.tokenCalls).toBeGreaterThanOrEqual(4)
    verify.mockRestore()
  })

  it('fails closed when token acquisition fails, then permits a clean later recovery', async () => {
    const { tracker, evidence } = await twoAnchorFixture()
    tracker.tokenFailure = new Error('trusted provider unavailable')
    const subject = coordinator(tracker)

    await expectCode(subject.verify({ beef: evidence, outputIndex: 0 }), 'invalid-evidence')
    tracker.tokenFailure = undefined
    await expect(subject.verify({ beef: evidence, outputIndex: 0 })).resolves.toMatchObject({
      outputIndex: 0
    })
  })

  it('keeps token I/O counted after cancellation and never publishes its late completion', async () => {
    const { tracker, evidence } = await twoAnchorFixture()
    const release = deferred<void>()
    const entered = deferred<void>()
    tracker.tokenGate = release.promise
    const originalToken = tracker.getVerificationContextToken.bind(tracker)
    tracker.getVerificationContextToken = async signal => {
      entered.resolve()
      return await originalToken(signal)
    }
    const subject = coordinator(tracker)
    const abort = new AbortController()
    const request = subject.verify({ beef: evidence, outputIndex: 0 }, { signal: abort.signal })

    await entered.promise
    abort.abort()
    await expectCode(request, 'cancelled')
    expect(subject.getStats().pendingChainCalls).toBe(1)
    release.resolve()
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(tracker.tokenAborts).toBe(1)
    expect(subject.getStats()).toMatchObject({ cachedTransactions: 0, pendingChainCalls: 0 })
  })

  it('rejects a shouldVerifyScripts mutation before publication and accepts a clean retry', async () => {
    const { tracker, firstEvidence } = await sharedAncestorFixture()
    let mutate = true
    const verifier: BdkVerifierInterface = {
      supportsMemoryLimit: true,
      shouldVerifyScripts: params => {
        if (mutate) {
          const source = params.tx.inputs[0]?.sourceTransaction
          if (source === undefined) throw new Error('fixture source is missing')
          source.outputs[0].satoshis++
        }
        return true
      },
      verifyScripts: async () => true
    }
    const subject = coordinator(tracker, {}, verifier)

    await expectCode(subject.verify({ beef: firstEvidence, outputIndex: 0 }), 'invalid-evidence')
    mutate = false
    await expect(subject.verify({ beef: firstEvidence, outputIndex: 0 })).resolves.toMatchObject({
      outputIndex: 0
    })
  })

  it.each([
    ['the JavaScript interpreter', undefined],
    [
      'a single backend call',
      {
        supportsMemoryLimit: true,
        verifyScripts: async () => {
          throw new ScriptResourceLimitError('stack', 1, 2)
        }
      } satisfies BdkVerifierInterface
    ],
    [
      'a batch backend call',
      {
        supportsMemoryLimit: true,
        verifyScripts: async () => true,
        verifyScriptsBatch: async () => {
          throw new ScriptResourceLimitError('stack', 1, 2)
        }
      } satisfies BdkVerifierInterface
    ]
  ])(
    'maps script resource exhaustion from %s to the local limit error',
    async (_path, verifier) => {
      const { tracker, evidence } = await fixture()
      const subject = coordinator(tracker, { scriptMemoryBytes: 1 }, verifier)
      await expectCode(subject.verify({ beef: evidence, outputIndex: 0 }), 'limit')
    }
  )
})
