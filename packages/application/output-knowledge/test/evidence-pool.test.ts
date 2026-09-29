import { describe, expect, it } from '@jest/globals'
import { Beef, Utils } from '@bsv/sdk'
import { EvidencePool, type EvidenceReceipt } from '../src/EvidencePool.js'
import { SDKEvidenceVerifier } from '../src/index.js'
import { candidate, chain, context, corpus, resolver } from './evidence-fixture.js'

function receipt(
  id: string,
  received: string,
  name: string,
  partial = false,
  group = id
): EvidenceReceipt {
  let evidence = candidate(name).evidence
  if (partial) {
    const beef = new Beef()
    beef.mergeRawTx(Utils.toArray(corpus.transactions[name].raw, 'hex'))
    evidence = { ...evidence, beef: Utils.toBase64(beef.toBinary()) }
  }
  return { id, received, group, chain, evidence }
}

describe('cross-source evidence dependency planning', () => {
  it('joins a successor received first to a predecessor supplied by a different source', async () => {
    const pool = new EvidencePool('journal')
    expect(pool.receive('1', [receipt('host-a/child', '1', 'QC', true)])).toEqual({ rejected: [] })
    expect(pool.alternatives('host-a/child')).toMatchObject({ complete: false, limited: false })
    pool.receive('2', [receipt('host-b/parent', '2', 'Q')])
    const result = pool.alternatives('host-a/child')
    expect(result.complete).toBe(true)
    expect(
      pool.materialize(result.supports[0].basis, result.supports[0].receipts).candidate
    ).toEqual(result.supports[0].candidate)
    expect(result.supports[0]).toMatchObject({
      availableAt: '2',
      receipts: ['host-a/child', 'host-b/parent'],
      groups: ['host-a/child', 'host-b/parent']
    })
    expect(pool.firstRaw(chain, corpus.transactions.QC.txid)?.position).toBe('1')
    expect(pool.firstRaw(chain, corpus.transactions.Q.txid)?.position).toBe('2')
    expect(
      (
        await new SDKEvidenceVerifier(resolver).verify(
          result.supports[0].candidate,
          context(),
          new AbortController().signal
        )
      ).status
    ).toBe('verified')
    const parent = pool.materialize(result.supports[0].basis, result.supports[0].receipts, {
      txid: corpus.transactions.Q.txid,
      outputIndex: 0
    })
    expect(parent.candidate.evidence.txid).toBe(corpus.transactions.Q.txid)
    expect(
      (
        await new SDKEvidenceVerifier(resolver).verify(
          parent.candidate,
          context(),
          new AbortController().signal
        )
      ).status
    ).toBe('verified')
    expect(pool.alternatives('host-a/child', { through: '1' }).complete).toBe(false)
    expect(
      pool.alternatives('host-a/child', { allowedGroups: new Set(['host-a/child']) }).complete
    ).toBe(false)
  })

  it('does not backdate txid-only hints and orders same-receive raw transactions canonically', () => {
    const pool = new EvidencePool('journal'),
      beef = new Beef()
    beef.mergeTxidOnly(corpus.transactions.Q.txid)
    const hint = receipt('hint', '1', 'Q')
    hint.evidence.beef = Utils.toBase64(beef.toBinary())
    pool.receive('1', [hint])
    expect(pool.firstRaw(chain, corpus.transactions.Q.txid)).toBeUndefined()
    pool.receive('2', [receipt('child', '2', 'QC', true), receipt('parent', '2', 'Q')])
    expect(pool.firstRaw(chain, corpus.transactions.Q.txid)?.position).toBe('2')
    const txids = [
      ...new Set([
        corpus.transactions.Q.txid,
        corpus.transactions.QC.txid,
        corpus.transactions.P.txid
      ])
    ].sort()
    for (const [index, txid] of txids.entries())
      expect(pool.firstRaw(chain, txid)?.index).toBe(index)
    expect(pool.alternatives('hint').supports[0].availableAt).toBe('2')
  })

  it('retains invalid receipt identities without poisoning another valid observation', () => {
    const pool = new EvidencePool('journal'),
      bad = receipt('bad', '1', 'A')
    bad.evidence.beef = 'AA=='
    expect(pool.receive('1', [bad]).rejected[0]).toMatchObject({ id: 'bad', code: 'invalid' })
    expect(() => pool.receive('2', [receipt('bad', '2', 'A')])).toThrow('identity changed')
    pool.receive('2', [receipt('good', '2', 'A')])
    expect(pool.alternatives('good').complete).toBe(true)
    expect(pool.firstRaw(chain, corpus.transactions.A.txid)?.position).toBe('2')
  })

  it('does not let duplicate delivery or caller mutation change durable raw availability', () => {
    const pool = new EvidencePool('journal'),
      first = receipt('first', '1', 'A')
    pool.receive('1', [first])
    first.evidence.beef = 'AA=='
    pool.receive('2', [receipt('first', '2', 'A')])
    expect(pool.firstRaw(chain, corpus.transactions.A.txid)?.position).toBe('1')
    expect(pool.alternatives('first').supports[0].availableAt).toBe('1')
    expect(() => pool.receive('2', [])).toThrow('journal order')
    pool.receive('3', [receipt('next', '3', 'Q')])
    expect(pool.firstRaw(chain, corpus.transactions.Q.txid)?.index).toBe(0)
  })

  it('reports bounded-search exhaustion without declaring evidence invalid', () => {
    const pool = new EvidencePool('journal', { searchStates: 1 })
    pool.receive('1', [receipt('child', '1', 'QC', true)])
    pool.receive('2', [receipt('parent', '2', 'Q')])
    expect(pool.alternatives('child')).toMatchObject({ complete: false, limited: true })
    const bounded = new EvidencePool('bounded', { receipts: 1 })
    bounded.receive('1', [receipt('first', '1', 'A')])
    expect(() => bounded.receive('2', [receipt('second', '2', 'B')])).toThrow('retention')
    expect(bounded.firstRaw(chain, corpus.transactions.B.txid)).toBeUndefined()
  })

  it('keeps source-group prerequisites and same-chain boundaries on every alternative', () => {
    const pool = new EvidencePool('journal')
    pool.receive('1', [receipt('child', '1', 'QC', true, 'group-child')])
    const foreign = receipt('foreign-parent', '2', 'Q')
    foreign.chain = { ...chain, network: 'other-chain' }
    pool.receive('2', [foreign])
    expect(pool.alternatives('child').complete).toBe(false)
    expect(() => pool.materialize('child', ['child', 'foreign-parent'])).toThrow(
      'cross configured chains'
    )
    expect(() => pool.materialize('absent', ['absent'])).toThrow('unavailable')
    expect(() => pool.materialize('child', ['child', 'child'])).toThrow('receipt set')
    pool.receive('3', [receipt('parent', '3', 'Q', false, 'group-with-two-members')])
    expect(pool.alternatives('child').supports[0].groups).toEqual([
      'group-child',
      'group-with-two-members'
    ])
  })
  it('rejects malformed pool limits and duplicate receipt identities before retaining anything', () => {
    expect(() => new EvidencePool('')).toThrow('identity')
    expect(() => new EvidencePool('journal', { receipts: 0 })).toThrow('limit')
    expect(() => new EvidencePool('journal', { searchStates: 257 })).toThrow('limit')
    const pool = new EvidencePool('journal')
    expect(() => pool.receive('1', [receipt('same', '1', 'A'), receipt('same', '1', 'B')])).toThrow(
      'identity'
    )
    expect(pool.entries()).toEqual([])
    expect(() => pool.receive('1', [receipt('wrong-position', '2', 'A')])).toThrow('identity')
    pool.receive('1', [receipt('accepted', '1', 'A')])
    expect(pool.alternatives('accepted').complete).toBe(true)
  })

  it('reports absent support and bounded reconstruction without inventing a negative validity verdict', () => {
    const pool = new EvidencePool('journal')
    pool.receive('1', [receipt('child', '1', 'QC', true)])
    expect(() => pool.alternatives('absent')).toThrow('Unknown evidence receipt')
    expect(pool.alternatives('child', { through: '0' })).toMatchObject({
      complete: false,
      limited: false,
      supports: []
    })
    expect(pool.alternatives('child', { allowedGroups: new Set() })).toMatchObject({
      complete: false,
      limited: false,
      supports: []
    })
    expect(() => pool.materialize('child', ['child', 'missing'])).toThrow(
      'Supporting receipt is unavailable'
    )
    expect(() => pool.materialize('child', ['child'])).toThrow('incomplete')
    expect(() =>
      pool.materialize('child', ['child'], { txid: 'ff'.repeat(32), outputIndex: 0 })
    ).toThrow('cannot be reconstructed')
    const bounded = new EvidencePool('bounded', { supportReceipts: 1 })
    bounded.receive('1', [receipt('child', '1', 'QC', true)])
    bounded.receive('2', [receipt('parent', '2', 'Q')])
    expect(bounded.alternatives('child')).toMatchObject({ complete: false, limited: true })
    expect(() => bounded.materialize('child', ['child', 'parent'])).toThrow('receipt set')
  })

  it('orders alternative dependency sets by first availability then stable receipt identity', () => {
    const pool = new EvidencePool('journal')
    pool.receive('1', [receipt('child', '1', 'QC', true)])
    pool.receive('2', [receipt('z-early', '2', 'Q'), receipt('a-early', '2', 'Q')])
    pool.receive('3', [receipt('a-late', '3', 'Q')])
    const supports = pool.alternatives('child').supports
    expect(supports.map(row => row.receipts)).toEqual([
      ['a-early', 'child'],
      ['child', 'z-early'],
      ['a-late', 'child']
    ])
    expect(supports.map(row => row.availableAt)).toEqual(['2', '2', '3'])
    expect(pool.alternatives('child', { through: '2' }).supports).toHaveLength(2)
  })
})
