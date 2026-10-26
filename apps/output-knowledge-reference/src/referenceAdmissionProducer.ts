import {
  canonicalOutputJSON,
  closedOutputObject,
  decodeOutputBytes,
  incrementOutputU64,
  outputAssert,
  outputU64,
  Transaction,
  Utils,
  type OutputJSONObject
} from '@bsv/sdk'
import { SDKEvidenceVerifier } from '@bsv/output-knowledge'
import {
  collectionOutputIndexKey,
  type LookupIndexEdit,
  type LookupIndexStorage,
  type LookupIndexValue
} from '@bsv/output-knowledge/lookup'
import type { OperationStateStore, OperationStateSnapshot } from '@bsv/output-knowledge/operations'
import { SQLiteOperationStateStore } from '@bsv/output-knowledge/operations/sqlite'
import { Engine, getAdmissionHistory, type TopicManager } from '@bsv/overlay'
import {
  OVERLAY_ENGINE_POLICY_ID,
  overlayAdmissionContextDigest
} from '@bsv/overlay/EngineAdmission.ts'
import { retainedTopicAdmission } from '@bsv/overlay/RetainedTopicAdmission.ts'
import { MongoOverlayStorage } from '@bsv/overlay/storage/mongo/MongoOverlayStorage'
import type { ReferenceProducerContext } from './referenceProvider.js'
import {
  fixtureChain,
  referenceContext,
  referenceEvidence,
  referenceResolver,
  type FixtureRecord
} from './fixtureChain.js'

export const REFERENCE_TOPIC = 'tm_reference_records'
const NAMESPACE = 'reference-admission-commands'
const records: FixtureRecord[] = ['A', 'AC', 'Q', 'X']
const actions = ['publish', 'replace', 'withdraw', 'reintroduce'] as const
export type ReferenceAction = (typeof actions)[number]
const initial = {
  format: 'reference-admission-producer/1',
  serial: '0',
  withdrawn: false,
  pending: null
}
const limits = { configurationBytes: 4096, stateBytes: 4096 }
type Pending = { action: ReferenceAction; serial: string; acceptedAt: string; withdrawn: boolean }
type CommandState = { format: string; serial: string; withdrawn: boolean; pending: Pending | null }

type CommandPhase = { admit: FixtureRecord[]; project: FixtureRecord[] }
function commandPhases(action: ReferenceAction): CommandPhase[] {
  switch (action) {
    case 'publish':
      // Preserve the original producer's two bounded live groups. A provider
      // cannot split an indivisible three-output group to fit a two-item Open.
      return [
        { admit: ['A', 'Q'], project: ['A', 'Q'] },
        { admit: ['X'], project: ['X'] }
      ]
    case 'replace':
      return [{ admit: ['AC'], project: ['A', 'AC'] }]
    case 'withdraw':
      return [{ admit: [], project: ['Q'] }]
    case 'reintroduce':
      return [{ admit: ['A'], project: ['A'] }]
  }
}

/** Public fixed-fixture policy. Engine still verifies every submitted Script and proof. */
export function referenceTopicManager(): TopicManager {
  const allowed = new Set(records.map(name => referenceEvidence(name).evidence.txid))
  return {
    identifyAdmissibleOutputs(beef) {
      const tx = Transaction.fromBEEF(beef)
      return Promise.resolve({
        outputsToAdmit: allowed.has(tx.id('hex')) ? [0] : [],
        coinsToRetain: []
      })
    },
    getDocumentation: () => Promise.resolve('Fixed synthetic reference records; no live assets.'),
    getMetaData: () =>
      Promise.resolve({
        name: 'Reference records',
        shortDescription: 'Synthetic admission and projection workbench'
      })
  }
}

export async function createReferenceEngine(storage: MongoOverlayStorage): Promise<Engine> {
  const context = referenceContext({
    application: 'reference-engine',
    account: 'fixture',
    access: 'public'
  })
  const { tracker } = await referenceResolver.resolve(context.view, new AbortController().signal)
  return new Engine({ [REFERENCE_TOPIC]: referenceTopicManager() }, {}, storage, tracker)
}

function binding(
  context: ReferenceProducerContext,
  engine: Engine,
  storage: MongoOverlayStorage
): OutputJSONObject {
  outputAssert(
    engine.storage === storage && engine.chainTracker !== 'scripts only',
    'Reference producer requires actual retained Script/SPV admission',
    'unsupported'
  )
  outputAssert(
    canonicalOutputJSON({
      network: storage.admissionScope.network,
      genesisHash: storage.admissionScope.genesisHash
    }) === canonicalOutputJSON(fixtureChain),
    'Reference admission chain differs',
    'context-changed'
  )
  return {
    format: 'reference-admission-producer/1',
    identity: context.identity,
    topic: REFERENCE_TOPIC,
    scope: { ...storage.admissionScope },
    fixtures: records.map(name => ({ name, digest: referenceEvidence(name).variantId }))
  }
}

/** Transfers ownership of the command store; Mongo/Engine lifetime stays with the installer. */
export async function createReferenceAdmissionProducer(
  context: ReferenceProducerContext,
  options: {
    engine: Engine
    storage: MongoOverlayStorage
    commands?: OperationStateStore
  }
) {
  const configuration = binding(context, options.engine, options.storage)
  const commands =
    options.commands ??
    (context.create
      ? SQLiteOperationStateStore.create(context.path, NAMESPACE, configuration, initial, limits)
      : SQLiteOperationStateStore.open(context.path, NAMESPACE, configuration, limits))
  try {
    return new ReferenceAdmissionProducer(
      context,
      options.engine,
      options.storage,
      commands,
      configuration
    )
  } catch (error) {
    await commands.close()
    throw error
  }
}

/**
 * Separate majority-committed admission and WAL/FULL materialized lookup state.
 * The saved command repairs the projection after an uncertain reply. It does
 * not claim that Mongo and SQLite commit atomically or that a receipt is mining.
 * This fixed public-fixture workflow never broadcasts, pays or runs GASP.
 */
export class ReferenceAdmissionProducer {
  private readonly manager: TopicManager
  private readonly tracker: Engine['chainTracker']
  private readonly history: NonNullable<ReturnType<typeof getAdmissionHistory>>
  private readonly index: LookupIndexStorage
  private readonly scope: MongoOverlayStorage['admissionScope']
  private work: Promise<string> | undefined
  private stopping = false
  private closed = false
  private readonly verifier = new SDKEvidenceVerifier(referenceResolver)

  constructor(
    context: ReferenceProducerContext,
    private readonly engine: Engine,
    private readonly storage: MongoOverlayStorage,
    private readonly commands: OperationStateStore,
    expectedBinding: OutputJSONObject
  ) {
    outputAssert(
      commands.durability === 'durable' &&
        commands.namespace === NAMESPACE &&
        canonicalOutputJSON(commands.configuration.binding) ===
          canonicalOutputJSON(expectedBinding) &&
        canonicalOutputJSON(commands.configuration.limits) === canonicalOutputJSON(limits),
      'Reference command custody differs',
      'context-changed'
    )
    const history = getAdmissionHistory(storage)
    outputAssert(
      history && Object.hasOwn(engine.managers, REFERENCE_TOPIC),
      'Retained reference admission is unavailable',
      'unsupported'
    )
    this.history = history
    this.manager = engine.managers[REFERENCE_TOPIC]
    this.tracker = engine.chainTracker
    this.index = context.index
    this.scope = { ...storage.admissionScope }
  }
  private current(): void {
    outputAssert(!this.stopping && !this.closed, 'Reference producer is stopping', 'cancelled')
    outputAssert(
      this.engine.storage === this.storage &&
        this.engine.managers[REFERENCE_TOPIC] === this.manager &&
        this.engine.chainTracker === this.tracker &&
        getAdmissionHistory(this.storage) === this.history &&
        canonicalOutputJSON(this.storage.admissionScope) === canonicalOutputJSON(this.scope),
      'Reference admission installation changed',
      'context-changed'
    )
  }
  private async load(): Promise<{ snapshot: OperationStateSnapshot; state: CommandState }> {
    this.current()
    const snapshot = await this.commands.read()
    this.current()
    const value = snapshot.value
    closedOutputObject(value, ['format', 'serial', 'withdrawn', 'pending'])
    outputAssert(
      value.format === initial.format && typeof value.withdrawn === 'boolean',
      'Invalid reference command state'
    )
    outputU64(value.serial)
    if (value.pending !== null) {
      const pending = value.pending
      closedOutputObject(pending, ['action', 'serial', 'acceptedAt', 'withdrawn'])
      outputAssert(
        actions.includes(pending.action as ReferenceAction) &&
          pending.serial === value.serial &&
          typeof pending.withdrawn === 'boolean',
        'Invalid retained reference command'
      )
      outputU64(pending.acceptedAt)
    }
    return { snapshot, state: value as CommandState }
  }
  private async saved(
    pending: Pending
  ): Promise<{ snapshot: OperationStateSnapshot; state: CommandState }> {
    const loaded = await this.load()
    outputAssert(
      canonicalOutputJSON(loaded.state.pending) === canonicalOutputJSON(pending),
      'Original reference command changed',
      'conflict'
    )
    return loaded
  }
  private async start(action?: ReferenceAction): Promise<string> {
    this.current()
    outputAssert(this.work === undefined, 'Reference producer physical work is occupied', 'limited')
    const work = this.run(action).finally(() => {
      if (this.work === work) this.work = undefined
    })
    this.work = work
    return await work
  }
  publish = () => this.start('publish')
  replace = () => this.start('replace')
  withdraw = () => this.start('withdraw')
  reintroduce = () => this.start('reintroduce')
  recover = () => this.start()

  private async run(action?: ReferenceAction): Promise<string> {
    const loaded = await this.load(),
      snapshot = loaded.snapshot
    let state = loaded.state
    if (state.pending === null) {
      if (action === undefined) return (await this.index.head()).sequence
      const pending: Pending = {
        action,
        serial: incrementOutputU64(state.serial),
        acceptedAt: String(Math.floor(Date.now() / 1000)),
        withdrawn: action === 'withdraw' || (action !== 'publish' && state.withdrawn)
      }
      const next = { ...state, serial: pending.serial, pending }
      const staged = await this.commands.compareAndSwap(snapshot.revision, next)
      this.current()
      outputAssert(
        staged.status !== 'conflict',
        'Reference command reservation conflicted',
        'conflict'
      )
      const retained = await this.saved(pending)
      state = retained.state
    } else if (action !== undefined)
      outputAssert(
        action === state.pending.action,
        'Another original reference command needs recovery',
        'conflict'
      )
    const pending = state.pending!
    let sequence = (await this.index.head()).sequence
    await commandPhases(pending.action).reduce(
      (previous, phase) =>
        previous.then(async () => {
          await phase.admit.reduce(
            (admitted, name) => admitted.then(() => this.admit(name, pending)),
            Promise.resolve()
          )
          sequence = await this.project(pending, phase.project)
        }),
      Promise.resolve()
    )
    const retained = await this.saved(pending)
    const completed = await this.commands.compareAndSwap(retained.snapshot.revision, {
      ...retained.state,
      withdrawn: pending.withdrawn,
      pending: null
    })
    this.current()
    outputAssert(
      completed.status !== 'conflict',
      'Reference command completion conflicted',
      'conflict'
    )
    return sequence
  }
  private async admit(name: FixtureRecord, pending: Pending): Promise<void> {
    const evidence = referenceEvidence(name).evidence
    const tx = Transaction.fromBEEF(decodeOutputBytes(evidence.beef))
    const query = {
      scope: { ...this.scope },
      txid: evidence.txid,
      topic: REFERENCE_TOPIC,
      policyId: OVERLAY_ENGINE_POLICY_ID,
      contextDigest: overlayAdmissionContextDigest()
    }
    await this.saved(pending)
    let result = await this.history.read(query)
    await this.saved(pending)
    if (result.state === 'unresolved') {
      // Historical mode still verifies Script/SPV; it suppresses live side effects.
      // An uncertain submit is recovered against the SAME retained identity.
      await this.engine.submit(
        { beef: Array.from(decodeOutputBytes(evidence.beef)), topics: [REFERENCE_TOPIC] },
        undefined,
        'historical-tx'
      )
      await this.saved(pending)
      result = await this.history.read(query)
      await this.saved(pending)
    }
    outputAssert(
      result.state === 'committed',
      'Original reference admission is unresolved',
      'unavailable'
    )
    const admitted = retainedTopicAdmission(result.admission, query, tx)
    outputAssert(
      admitted.steak[REFERENCE_TOPIC].outputsToAdmit.includes(evidence.outputIndex),
      'Reference output was not actually admitted',
      'unavailable'
    )
  }
  private async evaluateProjection(
    name: FixtureRecord,
    pending: Pending,
    sequence: string
  ): Promise<LookupIndexEdit | undefined> {
    const evidence = referenceEvidence(name).evidence
    const key = collectionOutputIndexKey(evidence)
    const previous = await this.index.row(key, sequence)
    const output = await this.storage.findOutput(
      evidence.txid,
      evidence.outputIndex,
      REFERENCE_TOPIC,
      false,
      true
    )
    await this.saved(pending)
    let next: LookupIndexValue | null = null
    if (output !== null && !(name === 'Q' && pending.withdrawn)) {
      outputAssert(
        output.beef !== undefined &&
          output.txid === evidence.txid &&
          output.outputIndex === evidence.outputIndex &&
          output.topic === REFERENCE_TOPIC &&
          !output.spent,
        'Stored reference output differs',
        'unavailable'
      )
      const original = referenceEvidence(name),
        tx = Transaction.fromBEEF(decodeOutputBytes(original.evidence.beef)),
        retained = Transaction.fromBEEF(output.beef),
        subject = tx.outputs[evidence.outputIndex]
      outputAssert(
        retained.toHex() === tx.toHex() &&
          subject.satoshis === output.satoshis &&
          subject.lockingScript.toHex() === Utils.toHex(output.outputScript),
        'Actual stored output differs from retained fixture evidence',
        'unavailable'
      )
      // Mongo's point output reader may return only the subject and proof.
      // The fixed producer owns the original complete ancestor closure;
      // bind it to the actual stored subject before independent verification.
      const stored = original.evidence
      const verified = await this.verifier.verify(
        original,
        referenceContext({
          application: 'reference-admission-projection',
          account: this.scope.nodeId,
          access: 'public'
        }),
        new AbortController().signal
      )
      await this.saved(pending)
      outputAssert(
        verified.status === 'verified',
        'Actual admission projection failed Script/SPV verification',
        'unavailable'
      )
      next = {
        expiresAt: null,
        data: { collection: 'records', audience: 'public', output: { evidence: { ...stored } } }
      }
    }
    if (canonicalOutputJSON(previous?.value ?? null) === canonicalOutputJSON(next)) return undefined
    return { key, previous: previous?.revision ?? null, next } satisfies LookupIndexEdit
  }
  private async project(pending: Pending, selected: FixtureRecord[]): Promise<string> {
    await this.saved(pending)
    const fence = await this.storage.getHistoryFence(REFERENCE_TOPIC)
    const head = await this.index.head()
    const evaluated = await Promise.allSettled(
      selected.map(name => this.evaluateProjection(name, pending, head.sequence))
    )
    await this.saved(pending)
    outputAssert(
      canonicalOutputJSON(await this.storage.getHistoryFence(REFERENCE_TOPIC)) ===
        canonicalOutputJSON(fence),
      'Reference source changed during projection',
      'conflict'
    )
    // Drain every started storage/verifier call before releasing physical ownership.
    const edits = evaluated.map(result => {
      if (result.status === 'rejected')
        throw result.reason instanceof Error
          ? result.reason
          : new Error('Reference projection failed', { cause: result.reason })
      return result.value
    })
    const changed = edits.filter((edit): edit is LookupIndexEdit => edit !== undefined)
    if (changed.length === 0) return head.sequence
    const committed = await this.index.commit({
      base: head.sequence,
      evaluatedAt: String(Math.floor(Date.now() / 1000)),
      edits: changed,
      event: {
        type: 'reference-admission-command/1',
        action: pending.action,
        serial: pending.serial
      }
    })
    await this.saved(pending)
    return committed.sequence
  }
  async close(): Promise<void> {
    if (this.closed) return
    this.stopping = true
    await this.work?.catch(() => undefined)
    await this.commands.close()
    this.closed = true
  }
}
