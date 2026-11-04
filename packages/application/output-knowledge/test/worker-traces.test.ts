import { describe, expect, it } from '@jest/globals'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Beef, Hash, Utils, OutputProtocolError } from '@bsv/sdk'
import { BitcoinKnowledge } from '../src/BitcoinKnowledge.js'
import { KnowledgeStore } from '../src/KnowledgeStore.js'
import { SDKEvidenceVerifier } from '../src/SDKEvidenceVerifier.js'
import { SQLiteJournal } from '../src/storage/SQLiteJournal.js'
import { knowledgeMutation } from '../src/storage/Journal.js'
import type {
  EvidenceVerifier,
  OutputObservation,
  OutputScope,
  SourceBatch,
  Mutation
} from '../src/ports.js'
import {
  candidate,
  chain,
  context,
  corpus,
  partition,
  resolver,
  transactions
} from './evidence-fixture.js'

interface TraceStep {
  op: string
  names?: string[]
  source?: string
  id?: string
  context?: string
  generation?: number
  sequence?: number
  phase?: 'snapshot'
  complete?: boolean
  verified?: boolean
  changes?: { outpoint: string; present: boolean }[]
  value?: Record<string, unknown>
}
interface Trace {
  name: string
  nonFinal?: boolean
  watch: string[]
  steps: TraceStep[]
}
const traces = JSON.parse(
  readFileSync(new URL('./fixtures/reconciliation-traces.json', import.meta.url), 'utf8')
) as Trace[]
const names = new Map(Object.entries(corpus.transactions).map(([name, tx]) => [tx.txid, name]))
const anchors = new Set(corpus.anchors.map(row => row.name))
const signal = () => new AbortController().signal
const txName = (txid: string): string => names.get(txid)!
const pointName = (point: { txid: string; outputIndex: number }): string =>
  `${txName(point.txid)}:${point.outputIndex}`

/**
 * Protocol binding of the unchanged approved trace corpus. Only scheduling and
 * source delivery are controlled here; every success/invalidity verdict comes
 * from SDKEvidenceVerifier, and all state/order comes from the real SQLite journal.
 */
class WorkerTrace {
  private readonly dir = mkdtempSync(join(tmpdir(), 'output-trace-'))
  private readonly path = join(this.dir, 'knowledge.sqlite')
  private readonly actual = new SDKEvidenceVerifier(resolver)
  private readonly allowed = new Map<string, Set<string>>()
  private readonly heldVariants = new Map<string, string>()
  private readonly releasedGroups = new Set<string>()
  private readonly delivered = new Map<string, SourceBatch>()
  private readonly sourceState = new Map<string, { generation: number; sequence: number }>()
  private readonly positions = new Map<string, number>([['0', 0]])
  private readonly views = new Map<string, string>()
  private readonly actionCalls: string[] = []
  private view = 'base'
  private position = 0
  private contextNumber = 0
  private offline = false
  private verificationCalls = 0
  worker!: BitcoinKnowledge
  store!: KnowledgeStore

  constructor(private readonly trace: Trace) {
    this.open()
  }
  private open(): void {
    const verifier: EvidenceVerifier = {
      verify: async (input, selected, abort) => {
        this.verificationCalls++
        if (this.offline) throw new Error('Journal replay called the verifier')
        const name = txName(input.evidence.txid),
          permissions = this.allowed.get(name),
          held = this.heldVariants.get(input.variantId)
        if (
          (held && !this.releasedGroups.has(held)) ||
          (!anchors.has(name) && !permissions?.has('*') && !permissions?.has(selected.view.id))
        )
          return {
            status: 'limited',
            contextId: selected.id,
            variantId: input.variantId,
            reason: 'Fixture verifier completion is not yet scheduled',
            dependencies: []
          }
        return this.actual.verify(input, selected, abort)
      }
    }
    this.worker = new BitcoinKnowledge({
      journalId: 'trace',
      partition,
      nonFinal: this.trace.nonFinal ?? true,
      verifier
    })
    this.store = new KnowledgeStore(new SQLiteJournal(this.path, 'trace'), this.worker, {
      partition
    })
  }
  private scope(source: string): OutputScope {
    return {
      chain,
      provider: source,
      service: 'records',
      queryDigest: '03'.repeat(32),
      rulesDigest: '04'.repeat(32),
      access: 'public',
      epoch: 'trace-epoch'
    }
  }
  private async commit(body: Mutation['body']): Promise<void> {
    const revision = await this.store.revision(),
      result = await this.store.commit(revision.received, knowledgeMutation(body))
    if (result.status !== 'committed' && result.status !== 'replayed')
      throw new Error(`Trace commit failed: ${result.status}`)
    if (!this.positions.has(result.revision.received))
      this.positions.set(result.revision.received, this.position)
  }
  private async advance(): Promise<void> {
    try {
      await this.worker.advance(this.store, signal())
    } catch (error) {
      if (!(error instanceof OutputProtocolError) || error.code !== 'limited') throw error
    }
  }
  private output(
    name: string,
    id: string,
    scope: OutputScope,
    beef: string,
    outputIndex = 0
  ): OutputObservation {
    return {
      id,
      scope,
      kind: 'output',
      payload: { evidence: { txid: corpus.transactions[name].txid, outputIndex, beef } }
    }
  }
  private batch(
    source: string,
    id: string,
    observations: OutputObservation[],
    generation: number,
    sequence: number,
    phase: 'snapshot' | 'live',
    complete = true
  ): SourceBatch {
    const scope = this.scope(source)
    return {
      provenance: {
        partition,
        scope,
        generation: String(generation),
        adapter: 'trace-source',
        authentication: 'configured-transport',
        peer: source,
        receivedAt: '1'
      },
      groups: [{ id, sequence: String(sequence), observations }],
      coverage: {
        scope,
        phase,
        status: complete ? 'complete' : 'partial',
        through: String(sequence),
        highWater: String(sequence)
      }
    }
  }
  private async changeView(id: string): Promise<void> {
    this.view = id
    const selected = context(id)
    selected.id = `${selected.id}-${this.contextNumber++}`
    this.views.set(selected.id, id)
    await this.commit({ kind: 'context', context: selected })
    if (id === 'included') {
      const source = 'chain-inclusion',
        state = this.sourceState.get(source),
        generation = (state?.generation ?? -1) + 1,
        value = this.batch(
          source,
          `included-${generation}`,
          [this.output('B', `included-${generation}`, this.scope(source), corpus.inclusion.beef)],
          generation,
          0,
          'snapshot'
        )
      this.sourceState.set(source, { generation, sequence: 0 })
      await this.commit({ kind: 'receive', batch: value })
    }
    await this.advance()
  }
  async initialize(): Promise<void> {
    await this.changeView('base')
    const source = 'chain-anchors',
      scope = this.scope(source),
      observations = corpus.anchors.map(row => this.output(row.name, row.name, scope, row.beef))
    await this.commit({
      kind: 'receive',
      batch: this.batch(source, 'anchors', observations, 0, 0, 'snapshot')
    })
    await this.advance()
  }
  private async receive(step: TraceStep): Promise<void> {
    const source = step.source!,
      prior = this.sourceState.get(source),
      snapshot = await this.store.read(),
      reset = snapshot.pendingGroups.some(
        row => row.scope.provider === source && row.reason.includes('quarantined')
      ),
      generation = (prior?.generation ?? 0) + (reset ? 1 : 0),
      sequence = (prior?.sequence ?? 0) + 1,
      scope = this.scope(source)
    // Seed only the named raw transactions and trusted anchors. Never smuggle a
    // missing predecessor into a child-first trace through Transaction.toBEEF().
    const beef = new Beef()
    for (const anchor of corpus.anchors) beef.mergeBeef(Utils.toArray(anchor.beef, 'base64'))
    for (const name of step.names!)
      beef.mergeRawTx(Utils.toArray(corpus.transactions[name].raw, 'hex'))
    const bytes = Utils.toBase64(beef.toBinary()),
      observations = step.names!.map(name =>
        this.output(name, `${this.position}-${name}`, scope, bytes)
      ),
      value = this.batch(
        source,
        `receive-${this.position}`,
        observations,
        generation,
        sequence,
        prior && !reset ? 'live' : 'snapshot'
      )
    await this.commit({ kind: 'receive', batch: value })
    this.sourceState.set(source, { generation, sequence })
    await this.advance()
  }
  private async membership(step: TraceStep): Promise<void> {
    const source = step.source!,
      generation = step.generation!,
      key = `${source}/${generation}/${step.id}`,
      previous = this.delivered.get(key)
    if (previous) {
      await this.commit({ kind: 'receive', batch: previous })
      await this.advance()
      return
    }
    const prior = this.sourceState.get(source),
      scope = this.scope(source),
      phase = step.phase ?? (prior?.generation === generation ? 'live' : 'snapshot'),
      observations = step.changes!.map((change, index): OutputObservation => {
        const [name, output] = change.outpoint.split(':'),
          outputIndex = Number(output),
          id = `${step.id}-${index}`
        if (!change.present)
          return {
            id,
            scope,
            kind: 'withdraw',
            payload: {
              outpoint: { chain, txid: corpus.transactions[name].txid, outputIndex },
              reason: 'Trace membership change'
            }
          }
        const beef = new Beef()
        beef.mergeBeef(Utils.toArray(candidate(name).evidence.beef, 'base64'))
        // A harmless unrelated txid-only entry distinguishes this retained proof
        // variant for scheduler control. Exact-target SDK verification still runs.
        beef.mergeTxidOnly(Utils.toHex(Hash.sha256(Utils.toArray(key, 'utf8'))))
        const bytes = beef.toBinary(),
          encoded = Utils.toBase64(bytes)
        if (step.verified === false) this.heldVariants.set(Utils.toHex(Hash.sha256(bytes)), key)
        return this.output(name, id, scope, encoded, outputIndex)
      }),
      value = this.batch(
        source,
        step.id!,
        observations,
        generation,
        step.sequence!,
        phase,
        step.phase === 'snapshot' ? step.complete === true : true
      )
    if (prior && generation < prior.generation) {
      const before = await this.store.read()
      await expect(this.commit({ kind: 'receive', batch: value })).rejects.toMatchObject({
        code: 'context-changed'
      })
      expect(await this.store.read()).toEqual(before)
      return
    }
    await this.commit({ kind: 'receive', batch: value })
    this.sourceState.set(source, { generation, sequence: step.sequence! })
    this.delivered.set(key, value)
    await this.advance()
  }
  private async restart(): Promise<void> {
    const before = await this.store.read(),
      count = this.verificationCalls
    await this.store.close()
    this.open()
    this.offline = true
    try {
      expect(await this.store.read()).toEqual(before)
    } finally {
      this.offline = false
    }
    expect(this.verificationCalls).toBe(count)
  }
  async step(step: TraceStep): Promise<void> {
    switch (step.op) {
      case 'receive':
        this.position++
        await this.receive(step)
        break
      case 'membership':
        this.position++
        await this.membership(step)
        break
      case 'view':
        this.position++
        await this.changeView(step.id!)
        break
      case 'verify':
        for (const name of step.names!) {
          const set = this.allowed.get(name) ?? new Set<string>()
          set.add(step.context ?? '*')
          this.allowed.set(name, set)
        }
        await this.advance()
        break
      case 'membershipVerified':
        this.releasedGroups.add(`${step.source}/${step.generation}/${step.id}`)
        await this.advance()
        break
      case 'restart':
        await this.restart()
        break
      case 'expect':
        await this.check(step.value!)
        break
      default:
        throw new Error(`Unsupported trace operation ${step.op}`)
    }
  }
  private logical(position: string): number {
    const value = this.positions.get(position)
    if (value === undefined) throw new Error(`Unbound journal frontier ${position}`)
    return value
  }
  private async check(expected: Record<string, unknown>): Promise<void> {
    const input = await this.store.read(),
      state = input.reconciled,
      pending = new Set(state.pendingComponents.flatMap(row => row.txids)),
      rows = state.transactions.filter(row => !anchors.has(txName(row.txid))),
      usable = new Set<string>(),
      spent = new Map<string, string>()
    for (const row of state.transactions) {
      if (!['included', 'selected-final'].includes(row.status)) continue
      usable.add(txName(row.txid))
      if (!anchors.has(txName(row.txid)))
        for (const dependency of row.dependencies)
          spent.set(pointName(dependency), txName(row.txid))
    }
    const pendingInputs = new Set(
      [...pending].flatMap(txid =>
        transactions
          .get(txName(txid))!
          .inputs.map(row =>
            pointName({ txid: row.sourceTXID!, outputIndex: row.sourceOutputIndex })
          )
      )
    )
    // The fixture's "current" means usable/unconsumed in the locally selected
    // graph, never a fabricated provider-origin reported-unspent assessment.
    const actual: Record<string, unknown> = {
      states: rows
        .map(
          row =>
            `${txName(row.txid)}:${pending.has(row.txid) && row.status !== 'included' ? 'pending' : row.status}`
        )
        .sort(),
      current: this.trace.watch
        .filter(
          point => usable.has(point.split(':')[0]) && !spent.has(point) && !pendingInputs.has(point)
        )
        .sort(),
      spent: [...spent]
        .filter(([point]) => this.trace.watch.includes(point))
        .map(([point, name]) => `${point}->${name}`)
        .sort(),
      orders: Object.fromEntries(
        rows
          .filter(row => row.order)
          .map(row => [
            txName(row.txid),
            {
              readyAt: this.logical(row.order!.readyAt),
              depth: row.order!.depth,
              firstRaw: this.logical(row.firstRaw.position),
              context: this.views.get(row.order!.readyContextId)
            }
          ])
      ),
      replacementJournal: state.replacements.map(
        row =>
          `${txName(row.previous)}->${txName(row.replacement)}@${this.logical(row.at)}/${this.views.get(row.contextId)}`
      ),
      memberships: state.memberships
        .filter(row => row.scope.provider === 'a' || row.scope.provider === 'b')
        .map(
          row =>
            `${row.scope.provider}/${row.generation}/${pointName(row.outpoint)}/${row.present ? 'present' : 'absent'}/${row.sequence}`
        )
        .sort(),
      view: this.view,
      walletActions: this.actionCalls.length
    }
    if (Object.hasOwn(expected, 'stale')) {
      // Recover the previous accepted component from retained accepted journal
      // states, so a process restart cannot erase what a stale UI is displaying.
      const previous = new Map<string, string>()
      for (const entry of (await this.store.inspect()).entries)
        if (entry.body.kind === 'accept' || entry.body.kind === 'reconcile')
          for (const row of entry.body.reconciled.transactions)
            if (['included', 'selected-final', 'selected-non-final'].includes(row.status))
              previous.set(row.txid, row.status)
      actual.stale = rows
        .filter(row => pending.has(row.txid) && previous.has(row.txid))
        .map(row => `${txName(row.txid)}:${previous.get(row.txid)}`)
        .sort()
    }
    for (const [key, value] of Object.entries(expected)) {
      expect(Object.hasOwn(actual, key)).toBe(true)
      expect({ field: key, value: actual[key] }).toEqual({ field: key, value })
    }
  }
  async close(): Promise<void> {
    await this.store.close()
    rmSync(this.dir, { recursive: true, force: true })
  }
}

describe('approved reconciliation traces through the default worker and SQLite journal', () => {
  it.each(traces)(
    '$name',
    async trace => {
      const runner = new WorkerTrace(trace)
      try {
        await runner.initialize()
        for (const step of trace.steps) await runner.step(step)
      } finally {
        await runner.close()
      }
    },
    30000
  )
})
