import { expect, it } from '@jest/globals'
import { canonicalOutputJSON } from '@bsv/sdk'
import { purchaseBuyerAliasFixture } from './private-purchase-buyer-alias.fixture.js'
import { purchaseBuyerFixture } from './private-purchase-buyer.fixture.js'

it('explicitly recovers a free fresh alias, independently verifies it, and leaves original native grant and wallet effects unchanged', async () => {
  const x = purchaseBuyerAliasFixture()
  try {
    const owner = await x.f.open(true),
      result = await owner.buyer.advance()
    expect(await owner.buyer.validate()).toBe('usable')
    const before = await owner.state.read(),
      calls = [...x.f.calls]
    const report = (await owner.buyer.currentAlias(x.make()))!
    expect(report.currentAlias.txid).toBe(x.aliasTxid)
    expect(x.counts).toEqual({ domainAliases: 1, chains: 1 })
    expect(x.f.calls).toEqual([...calls, 'recover'])
    expect(await owner.state.read()).toEqual(before)
    expect(canonicalOutputJSON(await owner.buyer.usableResult())).toBe(canonicalOutputJSON(result))
    expect(x.f.counts.finish).toBe(1)
    expect(x.f.server.counts.issue).toBe(1)
    expect(() => report.placement.checkCurrent()).not.toThrow()
    x.current(false)
    expect(() => report.placement.checkCurrent()).toThrow('selected chain changed')
    expect(await owner.buyer.usableResult()).toEqual(result)
  } finally {
    await x.f.dispose()
  }
})

it('keeps missing currentness optional across native restart and never re-gates usable historical rights', async () => {
  const x = purchaseBuyerAliasFixture()
  try {
    const first = await x.f.open(true),
      historical = await first.buyer.advance()
    await first.buyer.validate()
    await x.f.close(first)
    const next = await x.f.open()
    x.report(false)
    expect(await next.buyer.currentAlias(x.make())).toBeUndefined()
    expect(x.counts).toEqual({ domainAliases: 0, chains: 0 })
    x.report(true)
    x.available(false)
    expect(await next.buyer.currentAlias(x.make())).toBeUndefined()
    expect(x.counts).toEqual({ domainAliases: 1, chains: 1 })
    expect(await next.buyer.usableResult()).toEqual(historical)
    expect(x.f.counts.finish).toBe(1)
    expect(x.f.server.counts.issue).toBe(1)
  } finally {
    await x.f.dispose()
  }
})

it('rejects a different independently derived alias commitment before consulting chain placement', async () => {
  const x = purchaseBuyerAliasFixture()
  try {
    const owner = await x.f.open(true),
      historical = await owner.buyer.advance()
    await owner.buyer.validate()
    x.validCommitment(false)
    await expect(owner.buyer.currentAlias(x.make())).rejects.toThrow(
      'changes original purchase commitment'
    )
    expect(x.counts).toEqual({ domainAliases: 1, chains: 0 })
    expect(await owner.buyer.usableResult()).toEqual(historical)
    expect(x.f.counts.finish).toBe(1)
  } finally {
    await x.f.dispose()
  }
})

it('rejects a provider alias outside the independently selected buyer view while preserving retained delivery', async () => {
  const x = purchaseBuyerAliasFixture()
  try {
    const owner = await x.f.open(true),
      historical = await owner.buyer.advance()
    await owner.buyer.validate()
    x.current(false)
    await expect(owner.buyer.currentAlias(x.make())).rejects.toThrow('selected chain changed')
    expect(await owner.buyer.usableResult()).toEqual(historical)
    expect(x.f.counts.finish).toBe(1)
    expect(x.f.server.counts.issue).toBe(1)
  } finally {
    await x.f.dispose()
  }
})

it('requires an explicitly selected commitment owner and a retained delivery before any fresh recovery call', async () => {
  const x = purchaseBuyerAliasFixture(),
    legacy = purchaseBuyerFixture()
  try {
    const prepared = await x.f.open(true)
    await expect(prepared.buyer.currentAlias(x.make())).rejects.toThrow('original paid obligation')
    expect(x.f.calls).toEqual([])
    const old = await legacy.open(true)
    await expect(old.buyer.currentAlias(x.make())).rejects.toMatchObject({ code: 'unsupported' })
    expect(legacy.calls).toEqual([])
    expect(legacy.counts.finish).toBe(0)
    expect(x.f.counts.finish).toBe(0)
  } finally {
    await legacy.dispose()
    await x.f.dispose()
  }
})
