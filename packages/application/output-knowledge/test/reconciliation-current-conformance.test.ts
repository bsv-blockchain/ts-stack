import { describe, expect, it } from '@jest/globals'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { Spend, Transaction, Utils } from '@bsv/sdk'
import {
  reconcileOutputSpends,
  isOutputTransactionFinal,
  type ReconciliationCandidate,
  type ReconciliationContext,
  type ReconciliationFrontier
} from '../src/SpendReconciler.js'
import { SQLiteJournal } from '../src/storage/SQLiteJournal.js'
import { knowledgeMutation } from '../src/storage/Journal.js'
import type { ReconciledState } from '../src/ports.js'

interface Corpus {
  transactions: Record<string, { txid: string; raw: string; scriptValid: boolean }>
  preverifiedRoots: string[]
  finalityContexts: Record<string, { height: number; mtp: number }>
  expiryRetirement: {
    name: string
    listingParent: string
    listingOutputIndex: number
    fundingParent: string
    expiryHeight: number
  }
  finality: { name: string; height: number; mtp: number; expected: boolean }[]
}
interface Trace {
  name: string
  nonFinal?: boolean
  watch: string[]
  steps: {
    op: string
    id?: string
    names?: string[]
    value?: { states: string[]; current: string[]; spent: string[]; walletActions: number }
  }[]
}
const vectors = readFileSync(
  new URL('./fixtures/brc295/reconciliation-vectors.json', import.meta.url)
)
const corpus = JSON.parse(vectors.toString()) as Corpus
const traces = JSON.parse(
  readFileSync(new URL('./fixtures/brc295/reconciliation-traces.json', import.meta.url), 'utf8')
) as Trace[]
const originalTraces = JSON.parse(
  readFileSync(new URL('./fixtures/reconciliation-traces.json', import.meta.url), 'utf8')
) as Trace[]

/** Explicit fixture-trusted roots and model heights are not genesis or SPV qualification. */
function context(id: string): ReconciliationContext {
  const model = corpus.finalityContexts[id]
  return {
    id: `model-${id}`,
    view: {
      id,
      chain: { network: 'brc295-height-model', genesisHash: '01'.repeat(32) },
      tipHash: createHash('sha256').update(id).digest('hex'),
      tipHeight: String(model.height),
      medianTimePast: String(model.mtp),
      chainPolicyDigest: '02'.repeat(32)
    }
  }
}

function validatedRetirement(): Transaction {
  const tx = Transaction.fromHex(corpus.transactions[corpus.expiryRetirement.name].raw)
  expect(tx.id('hex')).toBe(corpus.transactions[corpus.expiryRetirement.name].txid)
  for (const [inputIndex, input] of tx.inputs.entries()) {
    const name = corpus.preverifiedRoots.find(
      name => corpus.transactions[name].txid === input.sourceTXID
    )
    expect(name).toBeDefined()
    const parent = Transaction.fromHex(corpus.transactions[name!].raw)
    expect(parent.id('hex')).toBe(input.sourceTXID)
    const previous = parent.outputs[input.sourceOutputIndex]
    expect(
      new Spend({
        sourceTXID: input.sourceTXID!,
        sourceOutputIndex: input.sourceOutputIndex,
        sourceSatoshis: previous.satoshis!,
        lockingScript: previous.lockingScript,
        transactionVersion: tx.version,
        otherInputs: tx.inputs.filter((_, index) => index !== inputIndex),
        outputs: tx.outputs,
        inputIndex,
        unlockingScript: input.unlockingScript!,
        inputSequence: input.sequence!,
        lockTime: tx.lockTime,
        memoryLimit: 134217728
      }).validate()
    ).toBe(true)
  }
  return tx
}

describe('immutable PR295 reconciliation additions', () => {
  it('pins the current corpus and preserves every original trace without alteration', () => {
    expect(createHash('sha256').update(vectors).digest('hex')).toBe(
      '99b0abc601c4ea126dc4a0ede2868586369c7f7852fb4c084e5010410c334c85'
    )
    expect(traces).toHaveLength(originalTraces.length + 2)
    for (const original of originalTraces)
      expect(traces.find(trace => trace.name === original.name)).toEqual(original)
    expect(corpus.preverifiedRoots).toEqual([
      corpus.expiryRetirement.listingParent,
      corpus.expiryRetirement.fundingParent
    ])
  })

  it('executes every actual retirement input and retains strict candidate-block finality', () => {
    const tx = validatedRetirement()
    expect(tx.lockTime).toBe(corpus.expiryRetirement.expiryHeight)
    expect(tx.inputs.some(input => input.sequence !== 0xffffffff)).toBe(true)
    for (const item of corpus.finality) {
      const subject = Transaction.fromHex(corpus.transactions[item.name].raw)
      expect(
        isOutputTransactionFinal(subject, {
          tipHeight: String(item.height),
          medianTimePast: String(item.mtp)
        })
      ).toBe(item.expected)
    }
  })

  it.each(traces.filter(trace => !originalTraces.some(original => original.name === trace.name)))(
    '$name retains intent without spending before maturity, including durable replay',
    async trace => {
      validatedRetirement()
      const directory = mkdtempSync(join(tmpdir(), 'brc295-retirement-'))
      const path = join(directory, 'journal.sqlite')
      let journal = new SQLiteJournal(path, 'current-corpus')
      let selected: ReconciliationContext | undefined
      const frontiers: ReconciliationFrontier[] = []
      let position = 0
      let received = false
      let receivedAt = '0'
      let verified = false
      let state: ReconciledState | undefined
      const names = new Map(
        Object.entries(corpus.transactions).map(([name, tx]) => [tx.txid, name])
      )
      const roots = new Set(corpus.preverifiedRoots)
      try {
        for (const step of trace.steps) {
          if (step.op === 'view') {
            selected = context(step.id!)
            // The installed initial view precedes receipt position one.
            if (frontiers.length > 0) position++
            frontiers.push({ at: String(position), context: selected })
          } else if (step.op === 'receive') {
            expect(step.names).toEqual([corpus.expiryRetirement.name])
            received = true
            receivedAt = String(++position)
          } else if (step.op === 'verify') {
            expect(step.names).toEqual([corpus.expiryRetirement.name])
            verified = true
          } else if (step.op === 'restart') {
            await journal.close()
            journal = new SQLiteJournal(path, 'current-corpus')
            const entries = await journal.read('0', 100)
            expect(entries.at(-1)?.body).toMatchObject({ kind: 'reconcile', reconciled: state })
          } else if (step.op === 'expect') {
            const current = selected!
            const candidates: ReconciliationCandidate[] = [
              ...corpus.preverifiedRoots,
              ...(received ? [corpus.expiryRetirement.name] : [])
            ].map(name => {
              const source = corpus.transactions[name]
              const root = roots.has(name)
              const firstRaw = {
                journalId: 'current-corpus',
                position: root ? '0' : receivedAt,
                index: 0
              }
              return {
                txid: source.txid,
                rawTransaction: Utils.toBase64(Utils.toArray(source.raw, 'hex')),
                evidenceIds: [],
                firstRaw,
                order: {
                  firstRaw,
                  readyAt: firstRaw.position,
                  depth: 0,
                  readyContextId: frontiers[0].context.id
                },
                validation: root || verified ? 'verified' : 'unresolved',
                pendingSupport: !root && !verified,
                ...(root
                  ? {
                      placement: {
                        contextId: current.id,
                        blockHash: current.view.tipHash,
                        height: '0'
                      }
                    }
                  : {})
              }
            })
            state = reconcileOutputSpends({
              journalId: 'current-corpus',
              through: String(position),
              context: current,
              contexts: frontiers,
              nonFinal: trace.nonFinal ?? true,
              candidates,
              memberships: []
            })
            const retiring = state.transactions.find(
              row => names.get(row.txid) === corpus.expiryRetirement.name
            )!
            const consuming = retiring.status === 'selected-final' || retiring.status === 'included'
            expect({
              states: [`${corpus.expiryRetirement.name}:${retiring.status}`],
              spent: consuming
                ? [
                    `${corpus.expiryRetirement.listingParent}:${corpus.expiryRetirement.listingOutputIndex}->${corpus.expiryRetirement.name}`
                  ]
                : [],
              current: consuming ? [] : trace.watch,
              walletActions: 0
            }).toEqual(step.value)
            const mutation = knowledgeMutation({
              kind: 'reconcile',
              generation: '0',
              contextId: current.id,
              reconciled: state,
              assessments: []
            })
            expect((await journal.append((await journal.head()).received, mutation)).status).toBe(
              'committed'
            )
          } else throw new Error(`Unknown frozen conformance operation: ${step.op}`)
        }
      } finally {
        await journal.close()
        rmSync(directory, { recursive: true, force: true })
      }
    },
    30000
  )
})
