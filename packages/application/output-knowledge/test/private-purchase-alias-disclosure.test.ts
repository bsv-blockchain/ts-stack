import { expect, it, jest } from '@jest/globals'
import { canonicalOutputJSON, parseOutputPurchaseEnvelope, OutputProtocolError } from '@bsv/sdk'
import { purchaseAliasDisclosureFixture } from './private-purchase-alias-disclosure.fixture.js'

it('enqueues a fresh same-purchase alias under the existing native transaction and preserves historical signed bytes', async () => {
  const x = await purchaseAliasDisclosureFixture()
  try {
    const original = parseOutputPurchaseEnvelope(
      JSON.parse(x.native().prepare(x.id, x.caller).body)
    )
    const response = await x.make().prepareAsync(x.id, x.caller)
    const enriched = parseOutputPurchaseEnvelope(JSON.parse(response.body))
    expect(enriched.currentAlias).toEqual({ txid: x.selected.txid, beef: x.selected.beef })
    const { currentAlias: _alias, ...historical } = enriched
    expect(canonicalOutputJSON(historical)).toBe(canonicalOutputJSON(original))
    expect(enriched.result).toMatchObject({ status: 'delivered', txid: x.paid.txid })
    const send = jest.fn((_body: string, _headers: Readonly<Record<string, string>>) => undefined)
    response.enqueue(send)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][0]).toBe(response.body)
    expect(() => response.enqueue(send)).toThrow('already attempted')
    expect(x.f.base.counts.issue).toBe(1)
  } finally {
    await x.f.dispose()
  }
})

it('refuses a changed selected chain at physical enqueue but preserves a fresh historical recovery without another issue', async () => {
  const x = await purchaseAliasDisclosureFixture()
  try {
    const response = await x.make().prepareAsync(x.id, x.caller)
    x.f.setCurrent(false)
    const send = jest.fn((_body: string, _headers: Readonly<Record<string, string>>) => undefined)
    expect(() => response.enqueue(send)).toThrow('chain changed')
    expect(send).not.toHaveBeenCalled()
    expect(() => response.enqueue(send)).toThrow('already attempted')
    const recovered = await x.make().prepareAsync(x.id, x.caller)
    expect(JSON.parse(recovered.body).currentAlias).toBeUndefined()
    recovered.enqueue(send)
    expect(send).toHaveBeenCalledTimes(1)
    expect(x.f.base.counts.issue).toBe(1)
    expect(x.f.load().progress.status).toBe('delivered')
  } finally {
    await x.f.dispose()
  }
})

it('refuses changed native alias custody between authenticated bytes and physical enqueue', async () => {
  const x = await purchaseAliasDisclosureFixture()
  try {
    const response = await x.make().prepareAsync(x.id, x.caller)
    await x.f.submit(x.f.f.f.variant(72))
    const send = jest.fn((_body: string, _headers: Readonly<Record<string, string>>) => undefined)
    expect(() => response.enqueue(send)).toThrow()
    expect(send).not.toHaveBeenCalled()
    const next = await x.make().prepareAsync(x.id, x.caller)
    expect(JSON.parse(next.body).currentAlias.txid).not.toBe(x.selected.txid)
    next.enqueue(send)
    expect(send).toHaveBeenCalledTimes(1)
    expect(x.f.base.counts.issue).toBe(1)
  } finally {
    await x.f.dispose()
  }
})

it('keeps unknown or bounded chain work optional while preserving the complete historical result', async () => {
  const x = await purchaseAliasDisclosureFixture()
  try {
    const historical = x.native().prepare(x.id, x.caller).body
    for (const code of ['limited', 'unavailable', 'context-changed', 'cancelled'] as const) {
      const response = await x
        .make({
          async currentAlias() {
            throw new OutputProtocolError(code, 'Controlled report unavailable')
          }
        })
        .prepareAsync(x.id, x.caller)
      expect(response.body).toBe(historical)
      let sent: string | undefined
      response.enqueue(body => {
        sent = body
      })
      expect(sent).toBe(historical)
    }
    await expect(
      x
        .make({
          async currentAlias() {
            throw Error('Unexpected implementation failure')
          }
        })
        .prepareAsync(x.id, x.caller)
    ).rejects.toThrow('Unexpected implementation failure')
  } finally {
    await x.f.dispose()
  }
})

it('refuses a cross-acquisition or different-commitment report before constructing enriched bytes', async () => {
  const x = await purchaseAliasDisclosureFixture()
  try {
    const report = (await x.f.coordinator.currentAlias(x.id, x.caller))!
    for (const changed of [
      { acquisitionId: 'f0'.repeat(32) },
      { purchaseCommitment: 'f1'.repeat(32) }
    ])
      await expect(
        x
          .make({
            async currentAlias() {
              return { ...report, ...changed }
            }
          })
          .prepareAsync(x.id, x.caller)
      ).rejects.toThrow('changes original purchase identity')
    expect(x.f.base.counts.issue).toBe(1)
  } finally {
    await x.f.dispose()
  }
})

it('omits an optional alias that exceeds the complete response budget and leaves historical disclosure independent', async () => {
  const x = await purchaseAliasDisclosureFixture()
  try {
    const historical = x.native().prepare(x.id, x.caller).body
    const report = (await x.f.coordinator.currentAlias(x.id, x.caller))!
    const response = await x
      .make({
        async currentAlias() {
          return { ...report, maximumResponseBytes: Buffer.byteLength(historical) }
        }
      })
      .prepareAsync(x.id, x.caller)
    expect(response.body).toBe(historical)
    x.f.setCurrent(false)
    let sent: string | undefined
    response.enqueue(body => {
      sent = body
    })
    expect(sent).toBe(historical)
  } finally {
    await x.f.dispose()
  }
})

it('keeps synchronous default disclosure and preparation free of currentness calls', async () => {
  const x = await purchaseAliasDisclosureFixture()
  try {
    const assess = jest.fn(async () => {
      throw Error('Must not assess preparation')
    })
    const adapter = x.make({ currentAlias: assess })
    expect(adapter.prepare(x.id, x.caller).body).toBe(x.native().prepare(x.id, x.caller).body)
    const terms = await adapter.prepareAsync(x.id, x.caller, { terms: true })
    expect(JSON.parse(terms.body).body.acquisitionId).toBe(x.id)
    expect(assess).not.toHaveBeenCalled()
  } finally {
    await x.f.dispose()
  }
})

it.each(['missing', 'accessor'] as const)(
  'omits a %s optional alias without invoking accessors or re-gating historical enqueue',
  async kind => {
    const x = await purchaseAliasDisclosureFixture()
    try {
      const historical = x.native().prepare(x.id, x.caller).body,
        report = (await x.f.coordinator.currentAlias(x.id, x.caller))!,
        copy = { ...report }
      let invoked = false
      Reflect.deleteProperty(copy, 'currentAlias')
      if (kind === 'accessor')
        Object.defineProperty(copy, 'currentAlias', {
          get: () => {
            invoked = true
            throw Error('Report accessor must not run')
          }
        })
      const response = await x
        .make({
          async currentAlias() {
            return copy
          }
        })
        .prepareAsync(x.id, x.caller)
      expect(response.body).toBe(historical)
      expect(invoked).toBe(false)
      x.f.setCurrent(false)
      let sent: string | undefined
      response.enqueue(body => {
        sent = body
      })
      expect(sent).toBe(historical)
      expect(x.f.base.counts.issue).toBe(1)
    } finally {
      await x.f.dispose()
    }
  }
)

it('keeps a nonqualifying orphaned-alias assessment separate from historical custody and authentication', async () => {
  const x = await purchaseAliasDisclosureFixture()
  try {
    const historical = x.native().prepare(x.id, x.caller).body,
      adapter = x.make({
        async currentAlias() {
          throw new OutputProtocolError(
            'invalid',
            'Selected ancestry does not include retained alias'
          )
        }
      }),
      response = await adapter.prepareAsync(x.id, x.caller)
    expect(response.body).toBe(historical)
    expect(JSON.parse(response.body).currentAlias).toBeUndefined()
    let sent: string | undefined
    response.enqueue(body => {
      sent = body
    })
    expect(sent).toBe(historical)
    expect(x.f.base.counts.issue).toBe(1)
    await expect(
      adapter.prepareAsync(x.id, { ...x.caller, buyer: '02' + '44'.repeat(32) })
    ).rejects.toMatchObject({ code: 'unauthorized' })
    x.f.installation.serviceDomain.close()
    await expect(adapter.prepareAsync(x.id, x.caller)).rejects.toThrow()
  } finally {
    await x.f.dispose()
  }
})
