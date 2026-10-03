import { beforeAll, describe, expect, it } from '@jest/globals'
import { readFileSync } from 'node:fs'
import {
  Transaction,
  TransactionEvidenceCoordinator,
  Utils,
  Hash,
  type ChainTracker
} from '@bsv/sdk'
import {
  reconcileOutputSpends,
  isOutputTransactionFinal,
  canReplaceOutputTransaction,
  type ReconciliationCandidate,
  type ReconciliationFrontier,
  type ReconciliationContext
} from '../src/index.js'

interface FixtureTransaction {
  txid: string
  raw: string
  scriptValid: boolean
}
interface Header {
  height: number
  raw: string
  hash: string
}
interface Corpus {
  transactions: Record<string, FixtureTransaction>
  headers: Header[]
  views: Record<string, { tipHash: string }>
  anchors: { name: string; beef: string }[]
  inclusion: { name: string; beef: string }
  finality: { name: string; height: number; mtp: number; expected: boolean }[]
  replacements: [string, string, boolean][]
}
interface TraceStep {
  op: string
  names?: string[]
  id?: string
  context?: string
  value?: Record<string, unknown>
}
interface Trace {
  name: string
  nonFinal?: boolean
  watch: string[]
  steps: TraceStep[]
}
const corpus = JSON.parse(
  readFileSync(new URL('./fixtures/reconciliation-vectors.json', import.meta.url), 'utf8')
) as Corpus
const traces = JSON.parse(
  readFileSync(new URL('./fixtures/reconciliation-traces.json', import.meta.url), 'utf8')
) as Trace[]
const transactions = new Map(
  Object.entries(corpus.transactions).map(([name, item]) => [name, Transaction.fromHex(item.raw)])
)
const names = new Map(Object.entries(corpus.transactions).map(([name, item]) => [item.txid, name]))
const contexts: Record<string, ReconciliationContext> = {}
const trackers: Record<string, ChainTracker> = {}
const verdicts = new Map<string, boolean>()
const anchorNames = new Set(['root', 'P'])
const chain = { network: 'brc-reconciliation-fixture', genesisHash: corpus.headers[0].hash }

beforeAll(async () => {
  const headers = new Map<string, Header & { previous: string; merkleRoot: string; time: number }>()
  for (const header of corpus.headers) {
    const bytes = Utils.toArray(header.raw, 'hex')
    expect(Utils.toHex(Hash.hash256(bytes).reverse())).toBe(header.hash)
    const data = new DataView(Uint8Array.from(bytes).buffer)
    expect(data.getUint32(72, true)).toBe(0x207fffff)
    expect(BigInt('0x' + header.hash) <= 0x7fffffn << 232n).toBe(true)
    const previous = Utils.toHex(bytes.slice(4, 36).reverse())
    if (header.height > 0) expect(headers.get(previous)?.height).toBe(header.height - 1)
    headers.set(header.hash, {
      ...header,
      previous,
      merkleRoot: Utils.toHex(bytes.slice(36, 68).reverse()),
      time: data.getUint32(68, true)
    })
  }
  for (const [id, view] of Object.entries(corpus.views)) {
    const ancestry: NonNullable<ReturnType<typeof headers.get>>[] = []
    for (let header = headers.get(view.tipHash); header; header = headers.get(header.previous))
      ancestry.push(header)
    const times = ancestry
      .slice(0, 11)
      .map(header => header.time)
      .sort((a, b) => a - b)
    contexts[id] = {
      id: `verification-${id}`,
      view: {
        id,
        chain,
        tipHash: view.tipHash,
        tipHeight: String(ancestry[0].height),
        medianTimePast: String(times[Math.floor(times.length / 2)]),
        chainPolicyDigest: '01'.repeat(32)
      }
    }
    trackers[id] = {
      currentHeight: async () => ancestry[0].height,
      isValidRootForHeight: async (root, height) =>
        ancestry.some(header => header.height === height && header.merkleRoot === root)
    }
  }
  for (const anchor of corpus.anchors)
    transactions.get(anchor.name)!.merklePath = Transaction.fromAtomicBEEF(
      Utils.toArray(anchor.beef, 'base64')
    ).merklePath
  for (const transaction of transactions.values()) {
    for (const input of transaction.inputs)
      input.sourceTransaction = transactions.get(names.get(input.sourceTXID!) ?? '')
  }
  // These are actual Script/SPV verdicts. Fixture names and expected labels never
  // enter the production reconciler or supply a cryptographic success result.
  const verifier = new TransactionEvidenceCoordinator({
    chainTracker: trackers.base,
    chainNamespace: chain.network,
    policyId: 'fixture-chain'
  })
  try {
    for (const [name, transaction] of transactions) {
      let valid = false
      try {
        await verifier.verify({
          beef: transaction.toAtomicBEEF(),
          txid: transaction.id('hex'),
          outputIndex: 0
        })
        valid = true
      } catch {
        /* negative fixture */
      }
      verdicts.set(name, valid)
      expect(valid).toBe(corpus.transactions[name].scriptValid)
    }
    const included = Transaction.fromAtomicBEEF(Utils.toArray(corpus.inclusion.beef, 'base64'))
    await expect(included.verify(trackers.included)).resolves.toBe(true)
    await expect(included.verify(trackers.fork)).rejects.toThrow('Invalid merkle path')
  } finally {
    verifier.dispose()
  }
})

/** Unit binding supplies journal order; full store/assembler qualification is separate. */
class TraceInput {
  position = 0
  view = 'base'
  readonly raw = new Map<string, { position: number; index: number }>()
  readonly verified = new Set<string>()
  readonly frontiers: ReconciliationFrontier[] = [{ at: '0', context: contexts.base }]
  constructor(readonly nonFinal = true) {}
  step(step: TraceStep): void {
    if (step.op === 'receive') {
      this.position++
      const sorted = [...(step.names ?? [])].sort((a, b) =>
        corpus.transactions[a].txid < corpus.transactions[b].txid ? -1 : 1
      )
      sorted.forEach((name, index) => {
        if (!this.raw.has(name)) this.raw.set(name, { position: this.position, index })
      })
    } else if (step.op === 'verify') {
      if (!step.context || step.context === this.view)
        for (const name of step.names ?? []) this.verified.add(name)
    } else if (step.op === 'view') {
      this.position++
      this.view = step.id!
      this.frontiers.push({ at: String(this.position), context: contexts[this.view] })
    } else if (step.op === 'membership') this.position++
  }
  snapshot(watch: string[]): Record<string, unknown> {
    const readiness = new Map<string, { at: number; depth: number }>()
    const ready = (name: string): { at: number; depth: number } | undefined => {
      if (anchorNames.has(name)) return { at: 0, depth: 0 }
      if (readiness.has(name)) return readiness.get(name)
      const raw = this.raw.get(name)
      if (!raw) return undefined
      const parents = transactions
        .get(name)!
        .inputs.map(input => ready(names.get(input.sourceTXID!)!))
      if (parents.some(parent => !parent)) return undefined
      const at = Math.max(raw.position, ...parents.map(parent => parent!.at))
      const same = parents.filter(parent => parent!.at === at)
      const result = {
        at,
        depth: same.length ? 1 + Math.max(...same.map(parent => parent!.depth)) : 0
      }
      readiness.set(name, result)
      return result
    }
    const candidates: ReconciliationCandidate[] = []
    for (const name of new Set([...anchorNames, ...this.raw.keys()])) {
      const order = ready(name),
        raw = this.raw.get(name) ?? { position: 0, index: 0 }
      const firstRaw = { journalId: 'trace', position: String(raw.position), index: raw.index }
      const anchor =
        anchorNames.has(name) ||
        (this.view === 'included' && name === 'B' && this.verified.has(name))
      const verified = anchorNames.has(name) || this.verified.has(name)
      const readyContext = this.frontiers
        .filter(frontier => Number(frontier.at) <= (order?.at ?? 0))
        .at(-1)!.context.id
      candidates.push({
        txid: corpus.transactions[name].txid,
        rawTransaction: Utils.toBase64(Utils.toArray(corpus.transactions[name].raw, 'hex')),
        evidenceIds: [],
        firstRaw,
        ...(order
          ? {
              order: {
                firstRaw,
                readyAt: String(order.at),
                depth: order.depth,
                readyContextId: readyContext
              }
            }
          : {}),
        validation: verified ? (verdicts.get(name) ? 'verified' : 'invalid') : 'unresolved',
        pendingSupport: Boolean(order && !verified),
        ...(anchor
          ? {
              placement: {
                contextId: contexts[this.view].id,
                blockHash: contexts[this.view].view.tipHash,
                height: '0'
              }
            }
          : {})
      })
    }
    const state = reconcileOutputSpends({
      journalId: 'trace',
      through: String(this.position),
      context: contexts[this.view],
      contexts: this.frontiers,
      nonFinal: this.nonFinal,
      candidates,
      memberships: []
    })
    expect(state.contextId).toBe(contexts[this.view].id)
    for (const row of state.transactions)
      if (row.order) expect(row.order.readyContextId.startsWith('verification-')).toBe(true)
    const pending = new Set(state.pendingComponents.flatMap(component => component.txids))
    const rowNames = state.transactions.filter(row => !anchorNames.has(names.get(row.txid)!))
    const states = rowNames
      .map(
        row =>
          `${names.get(row.txid)}:${pending.has(row.txid) && row.status !== 'included' ? 'pending' : row.status}`
      )
      .sort()
    const spent = new Map<string, string>()
    const usable = new Set<string>()
    for (const row of state.transactions) {
      if (!['included', 'selected-final'].includes(row.status)) continue
      const name = names.get(row.txid)!
      usable.add(name)
      if (!anchorNames.has(name))
        for (const input of transactions.get(name)!.inputs)
          spent.set(`${names.get(input.sourceTXID!)}:${input.sourceOutputIndex}`, name)
    }
    const pendingInputs = new Set(
      [...pending].flatMap(txid =>
        transactions
          .get(names.get(txid)!)!
          .inputs.map(input => `${names.get(input.sourceTXID!)}:${input.sourceOutputIndex}`)
      )
    )
    const orders = Object.fromEntries(
      [...readiness].map(([name, order]) => [
        name,
        {
          readyAt: order.at,
          depth: order.depth,
          firstRaw: this.raw.get(name)!.position,
          context: this.frontiers.filter(frontier => Number(frontier.at) <= order.at).at(-1)!
            .context.view.id
        }
      ])
    )
    return {
      states,
      orders,
      current: watch
        .filter(
          outpoint =>
            usable.has(outpoint.split(':')[0]) &&
            !spent.has(outpoint) &&
            !pendingInputs.has(outpoint)
        )
        .sort(),
      spent: [...spent]
        .filter(([outpoint]) => watch.includes(outpoint))
        .map(([outpoint, name]) => `${outpoint}->${name}`)
        .sort(),
      replacementJournal: state.replacements.map(
        row =>
          `${names.get(row.previous)}->${names.get(row.replacement)}@${row.at}/${row.contextId.replace(/^verification-/, '')}`
      )
    }
  }
}

describe('BRC-192 concrete transaction selection', () => {
  it('retains a historical replacement when the surviving version needs fresh current-view evidence', () => {
    const anchor = (name: string): ReconciliationCandidate => ({
      txid: corpus.transactions[name].txid,
      rawTransaction: Utils.toBase64(Utils.toArray(corpus.transactions[name].raw, 'hex')),
      firstRaw: { journalId: 'history', position: '0', index: 0 },
      evidenceIds: [],
      validation: 'verified',
      pendingSupport: false,
      placement: {
        contextId: contexts.mature.id,
        blockHash: contexts.mature.view.tipHash,
        height: '0'
      }
    })
    const candidate = (name: string, position: string): ReconciliationCandidate => {
      const firstRaw = { journalId: 'history', position, index: 0 }
      return {
        txid: corpus.transactions[name].txid,
        rawTransaction: Utils.toBase64(Utils.toArray(corpus.transactions[name].raw, 'hex')),
        firstRaw,
        order: { firstRaw, readyAt: position, depth: 0, readyContextId: contexts.base.id },
        evidenceIds: [],
        validation: name === 'R' ? 'unresolved' : 'verified',
        historicalValidation: {
          [contexts.base.id]: 'verified',
          [contexts.mature.id]: name === 'R' ? 'unresolved' : 'verified'
        },
        pendingSupport: false
      }
    }
    const state = reconcileOutputSpends({
      journalId: 'history',
      through: '3',
      context: contexts.mature,
      contexts: [
        { at: '0', context: contexts.base },
        { at: '3', context: contexts.mature }
      ],
      nonFinal: true,
      candidates: [anchor('root'), anchor('P'), candidate('N', '1'), candidate('R', '2')],
      memberships: []
    })
    expect(state.replacements).toEqual([
      {
        previous: corpus.transactions.N.txid,
        replacement: corpus.transactions.R.txid,
        at: '2',
        contextId: contexts.base.id
      }
    ])
    expect(state.transactions.find(row => row.txid === corpus.transactions.N.txid)?.status).toBe(
      'conflicting'
    )
    expect(state.transactions.find(row => row.txid === corpus.transactions.R.txid)?.status).toBe(
      'unresolved'
    )
  })
  it('matches every finality and sequence comparison vector', () => {
    for (const vector of corpus.finality)
      expect(
        isOutputTransactionFinal(transactions.get(vector.name)!, {
          tipHeight: String(vector.height),
          medianTimePast: String(vector.mtp)
        })
      ).toBe(vector.expected)
    for (const [previous, next, expected] of corpus.replacements)
      expect(
        canReplaceOutputTransaction(
          transactions.get(previous)!,
          transactions.get(next)!,
          contexts.base.view
        )
      ).toBe(expected)
  })
  it.each(traces)('selection portion of $name', trace => {
    let input = new TraceInput(trace.nonFinal ?? true)
    const retained: TraceStep[] = []
    for (const step of trace.steps) {
      if (step.op === 'expect') {
        const actual = input.snapshot(trace.watch)
        for (const key of ['states', 'current', 'spent', 'orders', 'replacementJournal'])
          if (Object.hasOwn(step.value!, key)) expect(actual[key]).toEqual(step.value![key])
      } else if (step.op === 'restart') {
        const before = input.snapshot(trace.watch)
        input = new TraceInput(trace.nonFinal ?? true)
        for (const event of retained) input.step(event)
        expect(input.snapshot(trace.watch)).toEqual(before)
      } else {
        retained.push(step)
        input.step(step)
      }
    }
  })
})
