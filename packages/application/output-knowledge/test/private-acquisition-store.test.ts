import { expect, it } from '@jest/globals'
import {
  PrivateKey,
  ProtoWallet,
  P2PKH,
  PublicKey,
  canonicalOutputJSON,
  outputPacketDigest
} from '@bsv/sdk'
import {
  privateAcquisitionAddress,
  privateAcquisitionPrefix
} from '../src/private/PrivateAcquisitionState.js'
import { SQLitePrivateAcquisitionStore } from '../src/private/SQLitePrivateAcquisitionStore.js'
import { acquisitionStoreFixture } from './private-acquisition-store.fixture.js'

it('atomically reserves the original invoice, material, result space and permanent fences', async () => {
  const f = await acquisitionStoreFixture(),
    q = f.quote(),
    reopened = f.open()
  expect(q.state.progress.phase).toBe('quoted')
  expect(reopened.store.load(f.id, f.buyer, f.clock, f.guard)?.state).toEqual(q.state)
  expect(reopened.store.material(f.id, f.buyer, '1', f.clock, f.guard)).toBe('AQID')
  for (const kind of ['quote', 'acquisition', 'prefix-fence', 'funding-fence'] as const)
    expect(reopened.domain.ledger.enumerate(kind, null, 64, f.clock, f.guard).entries).toHaveLength(
      1
    )
  expect(
    reopened.domain.ledger.enumerate('delivery', null, 64, f.clock, f.guard).entries
  ).toHaveLength(3)
})
it('retains the exact original invoice when a retry proposes new price, prefix or material', async () => {
  const f = await acquisitionStoreFixture(),
    q = f.quote()
  const next = {
    ...f.original,
    challenge: { ...f.original.challenge, satoshis: '200', derivationPrefix: 'another-prefix' }
  }
  f.setNow('200')
  const retry = f.open().store.quote(next, 'Ag==', f.clock, f.guard)
  expect(retry.state).toEqual(q.state)
  expect(retry.original).toEqual(q.original)
  expect(f.owner.store.material(f.id, f.buyer, '1', f.clock, f.guard)).toBe('AQID')
})
it('conflicts on changed semantic request under the same buyer/service retry ID', async () => {
  const f = await acquisitionStoreFixture()
  f.quote()
  const request = { ...f.original.request, termsDigest: '77'.repeat(32) }
  const next = {
    ...f.original,
    request,
    challenge: {
      ...f.original.challenge,
      termsDigest: request.termsDigest,
      requestDigest: outputPacketDigest('acquire-request', request)
    }
  }
  expect(() => f.owner.store.quote(next, 'AQ==', f.clock, f.guard)).toThrow('original invoice')
})
it('enforces permanent prefix uniqueness across acquisitions before any new reservation', async () => {
  const f = await acquisitionStoreFixture()
  f.quote()
  const request = { ...f.original.request, requestId: 'another-acquisition' }
  const challenge = {
    ...f.original.challenge,
    requestDigest: outputPacketDigest('acquire-request', request),
    acquisitionId: outputPacketDigest('acquisition', {
      chain: f.f.f.chain,
      seller: f.f.f.seller,
      buyer: f.buyer,
      service: request.service,
      requestId: request.requestId
    })
  }
  expect(() =>
    f.open().store.quote({ ...f.original, request, challenge }, 'AQ==', f.clock, f.guard)
  ).toThrow('prefix is permanently reserved')
  expect(f.owner.store.load(challenge.acquisitionId, f.buyer, f.clock, f.guard)).toBeUndefined()
})
it('does not expose an existing acquisition or its material to another buyer', async () => {
  const f = await acquisitionStoreFixture(),
    q = f.quote(),
    other = new PrivateKey(90).toPublicKey().toString()
  expect(f.owner.store.load(f.id, other, f.clock, f.guard)).toBeUndefined()
  expect(f.owner.store.load('00'.repeat(32), other, f.clock, f.guard)).toBeUndefined()
  expect(() => f.owner.store.material(f.id, other, '1', f.clock, f.guard)).toThrow(
    'Acquisition is absent'
  )
  let calls = 0
  expect(() =>
    f.owner.store.disclose(q, other, f.clock, f.guard, () => {
      calls++
    })
  ).toThrow('Acquisition is absent')
  expect(calls).toBe(0)
})
it('recovers every paid phase and an immutable result through independent native connections', async () => {
  const f = await acquisitionStoreFixture(),
    pending = f.reserve()
  expect(f.open().store.load(f.id, f.buyer, f.clock, f.guard)?.state.progress).toEqual(
    pending.state.progress
  )
  f.setNow('32')
  const funded = f
    .open()
    .store.advance(
      f.id,
      f.buyer,
      pending.row.revision,
      { type: 'wallet-accepted', receipt: f.f.f.receipt(pending.state.progress) },
      f.clock,
      f.guard
    )
  expect(funded.state.progress.phase).toBe('funded')
  const intent = f
    .open()
    .store.advance(
      f.id,
      f.buyer,
      funded.row.revision,
      { type: 'prepare-delivery' },
      f.clock,
      f.guard
    )
  const delivered = f
    .open()
    .store.complete(f.id, f.buyer, intent.row.revision, 'BAUG', f.clock, f.guard)
  let response: unknown
  f.open().store.disclose(delivered, f.buyer, f.clock, f.guard, value => {
    response = value
  })
  expect(response).toMatchObject({
    status: 'delivered',
    result: { evidence: f.original.evidence, schema: f.original.schema, context: 'BAUG' },
    funding: pending.state.progress.funding!.operation.funding
  })
  expect(canonicalOutputJSON(response)).not.toContain('nativeReceipt')
  expect(
    f.open().store.complete(f.id, f.buyer, delivered.row.revision, 'BAUG', f.clock, f.guard).state
  ).toEqual(delivered.state)
  expect(() =>
    f.open().store.complete(f.id, f.buyer, delivered.row.revision, 'AQ==', f.clock, f.guard)
  ).toThrow('already immutable')
})
it('keeps a funded undelivered obligation after the original recovery deadline', async () => {
  const f = await acquisitionStoreFixture(),
    funded = f.fund()
  f.setNow('999999')
  expect(() =>
    f.owner.store.advance(f.id, f.buyer, funded.row.revision, { type: 'expire' }, f.clock, f.guard)
  ).toThrow('cannot expire')
  const intent = f.owner.store.advance(
    f.id,
    f.buyer,
    funded.row.revision,
    { type: 'prepare-delivery' },
    f.clock,
    f.guard
  )
  const delivered = f
    .open()
    .store.complete(f.id, f.buyer, intent.row.revision, 'AQ==', f.clock, f.guard)
  expect(delivered.state.progress.recoveryUntil).toBe('1086399')
})
it('accepts late first payment before recovery expiry and rejects first intake at the exact boundary', async () => {
  const f = await acquisitionStoreFixture(),
    q = f.quote()
  f.setNow('101')
  const pinned = f.owner.store.advance(
    f.id,
    f.buyer,
    q.row.revision,
    { type: 'pin', payment: f.f.f.payment() },
    f.clock,
    f.guard
  )
  expect(pinned.state.progress.candidate?.receivedAt).toBe('101')
  const g = await acquisitionStoreFixture(),
    other = g.quote()
  g.setNow(g.original.challenge.recoveryUntil)
  expect(() =>
    g.owner.store.advance(
      g.id,
      g.buyer,
      other.row.revision,
      { type: 'pin', payment: g.f.f.payment() },
      g.clock,
      g.guard
    )
  ).toThrow('after recovery expiry')
  expect(g.open().store.load(g.id, g.buyer, g.clock, g.guard)?.state.progress.candidate).toBeNull()
})
it('keeps exact pinned payment retries idempotent across recovery expiry', async () => {
  const f = await acquisitionStoreFixture(),
    pinned = f.pin()
  f.setNow('999999')
  const retry = f
    .open()
    .store.advance(
      f.id,
      f.buyer,
      pinned.row.revision,
      { type: 'pin', payment: f.f.f.payment() },
      f.clock,
      f.guard
    )
  expect(retry.revision).toBe(pinned.revision)
  expect(retry.state).toEqual(pinned.state)
})
it('rejects a stale writer and prevents a second credit transition', async () => {
  const f = await acquisitionStoreFixture(),
    pending = f.reserve(),
    second = f.open()
  const event = { type: 'wallet-accepted' as const, receipt: f.f.f.receipt(pending.state.progress) }
  f.owner.store.advance(f.id, f.buyer, pending.row.revision, event, f.clock, f.guard)
  expect(() =>
    second.store.advance(f.id, f.buyer, pending.row.revision, event, f.clock, f.guard)
  ).toThrow('progress changed')
  expect(second.store.load(f.id, f.buyer, f.clock, f.guard)?.state.progress.phase).toBe('funded')
})
it('requires a durable delivery intent and complete retained result for completion', async () => {
  const f = await acquisitionStoreFixture(),
    q = f.quote()
  expect(() =>
    f.owner.store.complete(f.id, f.buyer, q.row.revision, 'AQ==', f.clock, f.guard)
  ).toThrow('retained delivery intent')
  expect(() =>
    f.owner.store.advance(
      f.id,
      f.buyer,
      q.row.revision,
      { type: 'delivered' } as never,
      f.clock,
      f.guard
    )
  ).toThrow('requires retained result')
  expect(f.open().store.load(f.id, f.buyer, f.clock, f.guard)?.state).toEqual(q.state)
})
it('rolls back the whole quote when capacity cannot reserve every promised slot', async () => {
  const f = await acquisitionStoreFixture({ maximumRecords: 6 })
  expect(() => f.quote()).toThrow('capacity is full')
  const reopened = f.open()
  expect(reopened.store.load(f.id, f.buyer, f.clock, f.guard)).toBeUndefined()
  expect(
    reopened.domain.ledger.enumerate('prefix-fence', null, 64, f.clock, f.guard).entries
  ).toEqual([])
  expect(reopened.domain.ledger.enumerate('delivery', null, 64, f.clock, f.guard).entries).toEqual(
    []
  )
})
it('rechecks quote construction time and payment receipt time at the atomic native gate', async () => {
  const f = await acquisitionStoreFixture()
  let now = 19
  expect(() => f.owner.store.quote(f.original, 'AQ==', () => String(++now), f.guard)).toThrow(
    'clock changed before reservation'
  )
  f.setNow('22')
  const q = f.quote()
  let intake = 22
  expect(() =>
    f.owner.store.advance(
      f.id,
      f.buyer,
      q.row.revision,
      { type: 'pin', payment: f.f.f.payment() },
      () => String(++intake),
      f.guard
    )
  ).toThrow('event clock changed')
  expect(
    f.open().store.load(f.id, f.buyer, () => '30', f.guard)?.state.progress.candidate
  ).toBeNull()
})
it('refuses stale or revoked disclosure and rejects async enqueue before its body', async () => {
  const f = await acquisitionStoreFixture(),
    q = f.quote()
  let calls = 0
  expect(() =>
    f.owner.store.disclose(
      q,
      f.buyer,
      f.clock,
      () => {
        throw new Error('revoked')
      },
      () => {
        calls++
      }
    )
  ).toThrow('revoked')
  expect(() =>
    f.owner.store.disclose(q, f.buyer, f.clock, f.guard, async () => {
      calls++
    })
  ).toThrow('enqueue must be synchronous')
  f.owner.store.advance(
    f.id,
    f.buyer,
    q.row.revision,
    { type: 'pin', payment: f.f.f.payment() },
    f.clock,
    f.guard
  )
  expect(() =>
    f.owner.store.disclose(q, f.buyer, f.clock, f.guard, () => {
      calls++
    })
  ).toThrow('changed before disclosure')
  expect(calls).toBe(0)
})
it('preserves a definitive wallet rejection with its original funding and invoice', async () => {
  const f = await acquisitionStoreFixture(),
    pending = f.reserve()
  const failed = f.owner.store.advance(
    f.id,
    f.buyer,
    pending.row.revision,
    {
      type: 'wallet-rejected',
      operationId: pending.state.progress.funding!.operation.id,
      reason: 'native-definitive-rejection'
    },
    f.clock,
    f.guard
  )
  const reopened = f.open().store.load(f.id, f.buyer, f.clock, f.guard)!
  expect(reopened.state).toEqual(failed.state)
  expect(reopened.state.progress.phase).toBe('failed')
  expect(f.owner.store.quote(f.original, 'AQ==', f.clock, f.guard).state).toEqual(failed.state)
})
it('expires only an unpinned quote and retains its permanent original fences', async () => {
  const f = await acquisitionStoreFixture(),
    q = f.quote()
  f.setNow(f.original.challenge.recoveryUntil)
  const expired = f.owner.store.advance(
    f.id,
    f.buyer,
    q.row.revision,
    { type: 'expire' },
    f.clock,
    f.guard
  )
  expect(expired.state.progress.phase).toBe('expired')
  expect(
    f
      .open()
      .domain.ledger.read(
        [
          privateAcquisitionPrefix(f.owner.domain.identity, f.original).address,
          privateAcquisitionAddress(f.owner.domain.identity, 'quote', f.id)
        ],
        f.clock,
        f.guard
      )
      .records.every(Boolean)
  ).toBe(true)
})
it('rejects insufficient future progress capacity or another seller/chain installation', async () => {
  const f = await acquisitionStoreFixture()
  expect(
    () =>
      new SQLitePrivateAcquisitionStore(
        f.owner.domain,
        { ...f.limits, maximumStateBytes: 524288 },
        f.f.settings
      )
  ).toThrow('future reservation')
})

it('atomically refuses a funding outpoint already reserved through another derivation split', async () => {
  const f = await acquisitionStoreFixture()
  const sellerPaymentKey = (
    await new ProtoWallet(new PrivateKey(83)).getPublicKey({
      protocolID: [2, '3241645161d8'],
      keyID: 'a b c',
      counterparty: f.buyer,
      forSelf: true
    })
  ).publicKey
  const tx = f.f.f.transaction
  tx.outputs[1].lockingScript = new P2PKH().lock(PublicKey.fromString(sellerPaymentKey).toAddress())
  const firstOriginal = {
    ...f.original,
    challenge: { ...f.original.challenge, derivationPrefix: 'a b' }
  }
  const a = f.owner.store.quote(firstOriginal, 'AQ==', f.clock, f.guard)
  const request = { ...f.original.request, requestId: 'acquisition-other-funding' }
  const secondId = outputPacketDigest('acquisition', {
    chain: f.f.f.chain,
    seller: f.f.f.seller,
    buyer: f.buyer,
    service: request.service,
    requestId: request.requestId
  })
  const secondOriginal = {
    ...f.original,
    request,
    challenge: {
      ...f.original.challenge,
      acquisitionId: secondId,
      requestDigest: outputPacketDigest('acquire-request', request),
      derivationPrefix: 'a'
    }
  }
  const b = f.owner.store.quote(secondOriginal, 'Ag==', f.clock, f.guard)
  const payA = { ...f.f.f.payment(tx), derivationPrefix: 'a b', derivationSuffix: 'c' }
  const payB = { ...payA, derivationPrefix: 'a', derivationSuffix: 'b c' }
  const pinnedA = f.owner.store.advance(
    f.id,
    f.buyer,
    a.row.revision,
    { type: 'pin', payment: payA },
    f.clock,
    f.guard
  )
  const pinnedB = f.owner.store.advance(
    secondId,
    f.buyer,
    b.row.revision,
    { type: 'pin', payment: payB },
    f.clock,
    f.guard
  )
  const acceptance = {
    chain: f.f.f.chain,
    txid: tx.id('hex'),
    policy: { kind: 'local-admission' as const },
    acceptedAt: '19'
  }
  f.open().store.advance(
    f.id,
    f.buyer,
    pinnedA.row.revision,
    {
      type: 'reserve-funding',
      candidateDigest: pinnedA.state.progress.candidate!.digest,
      sellerPaymentKey,
      acceptance
    },
    f.clock,
    f.guard
  )
  expect(() =>
    f.open().store.advance(
      secondId,
      f.buyer,
      pinnedB.row.revision,
      {
        type: 'reserve-funding',
        candidateDigest: pinnedB.state.progress.candidate!.digest,
        sellerPaymentKey,
        acceptance
      },
      f.clock,
      f.guard
    )
  ).toThrow('already belongs to another acquisition')
  const after = f.open().store.load(secondId, f.buyer, f.clock, f.guard)!
  expect(after.state.progress.phase).toBe('quoted')
  expect(after.state.progress.funding).toBeNull()
  expect(after.row.revision).toBe(pinnedB.row.revision)
})
