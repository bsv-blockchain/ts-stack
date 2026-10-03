import { expect, it, jest } from '@jest/globals'
import {
  Beef,
  Hash,
  LockingScript,
  Utils,
  canonicalOutputJSON,
  decodeOutputBytes,
  outputPacketDigest,
  Transaction
} from '@bsv/sdk'
import { PrivatePurchaseCoordinator } from '../src/private/PrivatePurchaseCoordinator.js'
import { purchaseCoordinatorFixture } from './private-purchase-coordinator.fixture.js'
import { SQLitePrivatePurchaseEvidence } from '../src/private/SQLitePrivatePurchaseEvidence.js'
import { purchaseEvidenceFixture } from './private-purchase-evidence.fixture.js'
import type { ProtectedLedgerRecord } from '../src/private/ProtectedLedgerCodec.js'

it('reserves native proof custody, merges a same-transaction Merkle view and recovers its exact original bytes', () => {
  const f = purchaseEvidenceFixture(),
    { clock, guard } = f.base
  f.owner.reserve(f.original, clock, guard)
  f.owner.reserve(f.original, clock, guard)
  expect(f.owner.read(f.original, clock, guard).candidate).toBeNull()
  f.owner.propose(f.original, f.candidate, clock, guard).retain(clock, guard)
  const plan = f.owner.propose(f.original, f.alternate, clock, guard)
  const merged = Beef.fromBinaryStrict(decodeOutputBytes(plan.candidate.beef, 8192))
  expect(merged.txs).toHaveLength(3)
  expect(merged.findTxid(f.candidate.txid)!.tx!.toHex()).toBe(f.target.toHex())
  expect(merged.bumps[0].computeRoot()).toBe(f.path.computeRoot())
  plan.retain(clock, guard)
  const reopened = f.reopen(),
    result = reopened.read(f.original, clock, guard)
  expect(result.candidate).toEqual(plan.candidate)
  result.candidate!.beef = 'AA=='
  expect(reopened.read(f.original, clock, guard).candidate).toEqual(plan.candidate)
  expect(f.owner.propose(f.original, f.candidate, clock, guard).candidate).toEqual(plan.candidate)
})
it('never initializes missing proof custody during read or recovery and binds the complete installation', () => {
  const f = purchaseEvidenceFixture(),
    { clock, guard } = f.base
  expect(() => f.owner.read(f.original, clock, guard)).toThrow('missing')
  expect(() => f.owner.propose(f.original, f.candidate, clock, guard)).toThrow('missing')
  f.owner.reserve(f.original, clock, guard)
  const changed = new SQLitePrivatePurchaseEvidence(f.base.owner.domain, f.base.f.f.contracts, {
    ...f.limits,
    maximumUpdates: 7
  })
  expect(() => changed.reserve(f.original, clock, guard)).toThrow('binding changed')
  expect(f.owner.read(f.original, clock, guard).candidate).toBeNull()
})
it('keeps exact duplicates available when the pre-reserved update budget is exhausted', () => {
  const f = purchaseEvidenceFixture(1),
    { clock, guard } = f.base
  f.owner.reserve(f.original, clock, guard)
  f.owner.propose(f.original, f.candidate, clock, guard).retain(clock, guard)
  const duplicate = f.owner.propose(f.original, f.candidate, clock, guard)
  duplicate.retain(clock, guard)
  expect(() => f.owner.propose(f.original, f.alternate, clock, guard)).toThrow('capacity')
  expect(f.reopen().read(f.original, clock, guard).candidate).toEqual(f.candidate)
})
it('refuses malformed, differently targeted and mutable proof proposals before native retention', () => {
  const f = purchaseEvidenceFixture(),
    { clock, guard } = f.base
  f.owner.reserve(f.original, clock, guard)
  for (const candidate of [
    { ...f.candidate, beef: 'AA==' },
    { ...f.candidate, txid: '33'.repeat(32) },
    { ...f.candidate, acquisitionId: '44'.repeat(32) }
  ])
    expect(() => f.owner.propose(f.original, candidate, clock, guard)).toThrow()
  const plan = f.owner.propose(f.original, f.candidate, clock, guard)
  plan.candidate.beef = 'AA=='
  expect(() => plan.retain(clock, guard)).toThrow('proposal changed')
  expect(f.owner.read(f.original, clock, guard).candidate).toBeNull()
})
it('uses native CAS and the exact proof-generation guard for competing owners', () => {
  const f = purchaseEvidenceFixture(),
    { clock, guard } = f.base
  f.owner.reserve(f.original, clock, guard)
  const other = f.reopen(),
    first = f.owner.propose(f.original, f.candidate, clock, guard),
    second = other.propose(f.original, f.alternate, clock, guard)
  first.retain(clock, guard)
  expect(() => second.retain(clock, guard)).toThrow()
  expect(() => f.owner.read(f.original, clock, second.checkCurrent)).toThrow('view changed')
  expect(f.owner.read(f.original, clock, guard).candidate).toEqual(f.candidate)
})
it('recovers a committed proof after a lost native reply without consuming another update', () => {
  const f = purchaseEvidenceFixture(1),
    { clock, guard } = f.base,
    commit = f.base.owner.domain.ledger.commit.bind(f.base.owner.domain.ledger)
  let lose = false
  jest.spyOn(f.base.owner.domain.ledger, 'commit').mockImplementation((...args) => {
    const revision = commit(...args)
    if (lose) {
      lose = false
      throw new Error('Lost native proof reply')
    }
    return revision
  })
  const owner = new SQLitePrivatePurchaseEvidence(
    f.base.owner.domain,
    f.base.f.f.contracts,
    f.limits
  )
  owner.reserve(f.original, clock, guard)
  lose = true
  expect(() => owner.propose(f.original, f.candidate, clock, guard).retain(clock, guard)).toThrow(
    'Lost native'
  )
  const reopened = f.reopen()
  expect(reopened.read(f.original, clock, guard).candidate).toEqual(f.candidate)
  reopened.propose(f.original, f.candidate, clock, guard).retain(clock, guard)
  expect(canonicalOutputJSON(reopened.read(f.original, clock, guard).candidate)).toBe(
    canonicalOutputJSON(f.candidate)
  )
})
it('requires synchronous live authority for reservation, recovery and retention', () => {
  const f = purchaseEvidenceFixture(),
    { clock, guard } = f.base
  expect(() => f.owner.reserve(f.original, clock, async () => {})).toThrow('synchronous')
  f.owner.reserve(f.original, clock, guard)
  const plan = f.owner.propose(f.original, f.candidate, clock, guard)
  expect(() => plan.retain(clock, () => Promise.reject(new Error('Deferred authority')))).toThrow(
    'synchronously'
  )
  f.base.setPermitted(false)
  expect(() => plan.retain(clock, guard)).toThrow('authority changed')
  expect(() => f.owner.read(f.original, clock, guard)).toThrow('authority changed')
})

function coordinatedEvidence(maximumUpdates = 4) {
  const e = purchaseEvidenceFixture(maximumUpdates)
  Object.assign(e.base.candidate, e.candidate)
  const f = purchaseCoordinatorFixture({ evidence: e.owner }, e.base)
  const reopen = () =>
    f.reopen(domain => new SQLitePrivatePurchaseEvidence(domain, e.base.f.f.contracts, e.limits))
  return { e, f, reopen }
}
it('uses cumulative durable proof at admission, release and issuance while the first financial candidate stays immutable', async () => {
  const { e, f, reopen } = coordinatedEvidence()
  const seen: { kind: string; candidate: unknown }[] = []
  const admission = f.owner.admission.recover,
    release = f.owner.release.assess,
    issue = f.owner.domain.issue
  f.owner.admission.recover = async (...args) => {
    seen.push({ kind: 'admission', candidate: structuredClone(args[0].candidate) })
    return admission(...args)
  }
  f.owner.release.assess = async (...args) => {
    seen.push({ kind: 'release', candidate: structuredClone(args[2]) })
    return release(...args)
  }
  f.owner.domain.issue = async (...args) => {
    seen.push({ kind: 'issue', candidate: structuredClone(args[4]) })
    return issue(...args)
  }
  await reopen()
  try {
    await f.prepare()
    f.setAdmitted(false)
    await f.submit()
    const first = f.current()!.candidate
    await f.coordinator.submit(e.alternate, f.caller)
    const merged = f.owner.evidence!.read(
      f.current()!.custody.original,
      f.f.clock,
      f.f.guard
    ).candidate!
    expect(Beef.fromBinaryStrict(decodeOutputBytes(merged.beef, 8192)).txs).toHaveLength(3)
    expect(f.current()!.candidate).toEqual(first)
    await reopen()
    f.setAdmitted(true)
    await f.recover()
    for (const kind of ['admission', 'release', 'issue'])
      expect(seen.filter(item => item.kind === kind).at(-1)!.candidate).toEqual(merged)
    const result = f.projected(),
      counts = { ...f.counts }
    await f.coordinator.submit(e.candidate, f.caller)
    await reopen()
    await f.recover()
    expect(f.projected()).toEqual(result)
    expect(f.counts.issue).toBe(counts.issue)
    expect(f.counts.admission).toBe(counts.admission)
    expect(f.counts.potatoes).toBe(counts.potatoes)
    expect(f.current()!.candidate).toEqual(first)
  } finally {
    await f.dispose()
  }
})
it.each(['pin', 'proof'] as const)(
  'recovers original native custody after a lost %s reply without a second effect',
  async where => {
    const { e, f, reopen } = coordinatedEvidence(1)
    let lose = true
    if (where === 'pin') {
      const original = f.owner.store.pin.bind(f.owner.store)
      f.owner.store.pin = (...args) => {
        const result = original(...args)
        if (lose) {
          lose = false
          throw new Error('Lost financial pin reply')
        }
        return result
      }
    } else {
      const original = e.base.owner.domain.ledger.commit.bind(e.base.owner.domain.ledger)
      jest.spyOn(e.base.owner.domain.ledger, 'commit').mockImplementation((...args) => {
        const result = original(...args)
        // Proof writes use bounded reserved chunk batches; preparation and the
        // immutable financial pin use the separate store's larger reservation.
        if (lose && args[4]?.maximumBatchBytes === 215040 && args[1][0].expectedRevision !== null) {
          lose = false
          throw new Error('Lost proof commit reply')
        }
        return result
      })
      f.owner.evidence = new SQLitePrivatePurchaseEvidence(
        e.base.owner.domain,
        e.base.f.f.contracts,
        e.limits
      )
    }
    const coordinator = new PrivatePurchaseCoordinator(f.owner)
    try {
      await coordinator.prepare(f.f.f.f.request, f.caller)
      await expect(coordinator.submit(e.candidate, f.caller)).rejects.toThrow('Lost')
      expect(f.current()!.candidate).toEqual(e.candidate)
      expect(f.counts.admission).toBe(0)
      await coordinator.stop()
      await reopen()
      await f.recover()
      expect(f.current()!.progress.status).toBe('delivered')
      expect(
        f.owner.evidence!.read(f.current()!.custody.original, f.f.clock, f.f.guard).candidate
      ).toEqual(e.candidate)
      expect(f.counts.admission).toBe(1)
      expect(f.counts.issue).toBe(1)
      await f.recover()
      expect(f.counts.issue).toBe(1)
    } finally {
      await coordinator.stop()
      await f.dispose()
    }
  }
)
it('independently rejects combined evidence before pinning or retaining incoming bytes', async () => {
  const { f, reopen } = coordinatedEvidence()
  let verifying = 0
  const original = f.owner.domain.verify
  f.owner.domain.verify = async (...args) => {
    if (++verifying === 2) throw new Error('Combined evidence refused')
    return original(...args)
  }
  await reopen()
  try {
    await f.prepare()
    await expect(f.submit()).rejects.toThrow('Combined evidence refused')
    expect(f.current()!.candidate).toBeNull()
    expect(
      f.owner.evidence!.read(f.current()!.custody.original, f.f.clock, f.f.guard).candidate
    ).toBeNull()
    expect(f.counts.admission).toBe(0)
    expect(f.counts.issue).toBe(0)
    await f.submit()
    expect(f.current()!.progress.status).toBe('delivered')
  } finally {
    await f.dispose()
  }
})
it('refuses missing original proof custody on recovery rather than manufacturing a new namespace', async () => {
  const e = purchaseEvidenceFixture()
  Object.assign(e.base.candidate, e.candidate)
  const f = purchaseCoordinatorFixture({}, e.base)
  try {
    await f.prepare()
    f.setAdmitted(false)
    await f.submit()
    await f.reopen(
      domain => new SQLitePrivatePurchaseEvidence(domain, e.base.f.f.contracts, e.limits)
    )
    const counts = { ...f.counts }
    await expect(f.recover()).rejects.toMatchObject({ code: 'unavailable' })
    await expect(f.prepare()).rejects.toMatchObject({ code: 'unavailable' })
    expect(f.counts.admission).toBe(counts.admission)
    expect(f.counts.issue).toBe(counts.issue)
  } finally {
    await f.dispose()
  }
})
it('checks the exact native proof generation again before physical admission', async () => {
  const { e, f, reopen } = coordinatedEvidence()
  f.owner.admission.recover = async (job, _signal, context) => {
    const original = f.current()!.custody.original
    f.owner
      .evidence!.propose(original, e.alternate, f.f.clock, f.f.guard)
      .retain(f.f.clock, f.f.guard)
    context.checkCurrent()
    throw new Error('Unreachable stale physical admission')
  }
  await reopen()
  try {
    await f.prepare()
    await expect(f.submit()).rejects.toMatchObject({ code: 'context-changed' })
    expect(f.current()!.progress.status).toBe('admission-pending')
    expect(f.counts.issue).toBe(0)
  } finally {
    await f.dispose()
  }
})

it.each(['assess', 'issue', 'sign'] as const)(
  'refuses a changed proof view across the %s await before disclosing a private result',
  async boundary => {
    const { e, f, reopen } = coordinatedEvidence()
    const change = () => {
      const original = f.current()!.custody.original
      f.owner
        .evidence!.propose(original, e.alternate, f.f.clock, f.f.guard)
        .retain(f.f.clock, f.f.guard)
    }
    if (boundary === 'assess') {
      const prior = f.owner.release.assess
      f.owner.release.assess = async (...args) => {
        const result = await prior(...args)
        change()
        return result
      }
    } else if (boundary === 'issue') {
      const prior = f.owner.domain.issue
      f.owner.domain.issue = async (...args) => {
        const result = await prior(...args)
        change()
        return result
      }
    } else {
      const prior = f.owner.sign
      f.owner.sign = async (...args) => {
        const result = await prior(...args)
        if (args[0] === 'potatoes') change()
        return result
      }
    }
    await reopen()
    try {
      await f.prepare()
      await expect(f.submit()).rejects.toMatchObject({ code: 'context-changed' })
      expect(f.current()!.progress.status).toBe('admitted-delivery-pending')
      expect(f.current()!.progress.delivery).toBeNull()
      if (boundary === 'assess') expect(f.counts.issue).toBe(0)
      if (boundary !== 'sign') expect(f.counts.potatoes).toBe(0)
    } finally {
      await f.dispose()
    }
  }
)
it('refuses promised local proof authority and replacement installed methods before an effect', async () => {
  const { e, f, reopen } = coordinatedEvidence()
  await reopen()
  try {
    await f.prepare()
    const evidence = f.owner.evidence!,
      read = evidence.read.bind(evidence)
    evidence.read = (() => Promise.reject(new Error('Deferred proof read'))) as never
    const promised = new PrivatePurchaseCoordinator(f.owner)
    try {
      await expect(promised.prepare(f.f.f.f.request, f.caller)).rejects.toMatchObject({
        code: 'context-changed'
      })
    } finally {
      await promised.stop()
    }
    await expect(f.submit()).rejects.toMatchObject({ code: 'context-changed' })
    evidence.read = read
    expect(f.counts.admission).toBe(0)
    const changed = new PrivatePurchaseCoordinator(f.owner)
    evidence.propose = (() => Promise.reject(new Error('Deferred proof proposal'))) as never
    await expect(changed.submit(e.candidate, f.caller)).rejects.toMatchObject({
      code: 'context-changed'
    })
    await changed.stop()
    expect(f.current()!.candidate).toBeNull()
  } finally {
    await f.dispose()
  }
})
it('reserves full future native proof capacity before exposing preparation and leaves no financial intent on failure', async () => {
  const e = purchaseEvidenceFixture(),
    owner = e.owner,
    f = purchaseCoordinatorFixture({ evidence: owner }, e.base),
    addresses = [0, 1].map(index =>
      e.base.owner.domain.identity.address('wallet', { purpose: 'occupied-capacity', index })
    ),
    read = e.base.owner.domain.ledger.read(addresses, e.base.clock, e.base.guard)
  e.base.owner.domain.ledger.commit(
    read.revision,
    addresses.map(address => ({
      ...address,
      expectedRevision: null,
      reservedBytes: 2047152,
      reservedUpdates: 0,
      value: { fixture: 'reserved elsewhere' }
    })),
    e.base.clock,
    e.base.guard
  )
  try {
    await expect(f.prepare()).rejects.toMatchObject({ code: 'limited' })
    expect(f.current()).toBeUndefined()
    expect(f.counts.admission).toBe(0)
    expect(f.counts.issue).toBe(0)
    expect(() => owner.read(e.original, f.f.clock, f.f.guard)).toThrow('missing')
  } finally {
    await f.dispose()
  }
})
it('retains complete large evidence through several pre-reserved encrypted chunks and native reopen', () => {
  const e = purchaseEvidenceFixture(),
    owner = new SQLitePrivatePurchaseEvidence(e.base.owner.domain, e.base.f.f.contracts, {
      ...e.limits,
      maximumCandidateBytes: 600000
    })
  e.target.addOutput({
    satoshis: 0,
    lockingScript: LockingScript.fromASM('OP_FALSE OP_RETURN ' + 'ab'.repeat(180000))
  })
  const beef = new Beef()
  beef.mergeTransaction(e.target)
  const candidate = {
    ...e.candidate,
    txid: e.target.id('hex'),
    beef: Utils.toBase64(beef.toBinaryAtomic(e.target.id('hex')))
  }
  owner.reserve(e.original, e.base.clock, e.base.guard)
  owner
    .propose(e.original, candidate, e.base.clock, e.base.guard)
    .retain(e.base.clock, e.base.guard)
  const opened = e.base.open(),
    recovered = new SQLitePrivatePurchaseEvidence(opened.domain, e.base.f.f.contracts, {
      ...e.limits,
      maximumCandidateBytes: 600000
    })
  expect(recovered.read(e.original, e.base.clock, e.base.guard).candidate).toEqual(candidate)
  e.base.close(opened.domain)
})

it('keeps an unsubmitted preparation pending until its original recovery deadline without creating evidence', async () => {
  const { f, reopen } = coordinatedEvidence()
  try {
    await f.prepare()
    await f.recover()
    expect(f.current()!.progress.status).toBe('prepared')
    expect(
      f.owner.evidence!.read(f.current()!.custody.original, f.f.clock, f.f.guard).candidate
    ).toBeNull()
    await reopen()
    await f.prepare()
    expect(f.counts.prepare).toBe(1)
    f.f.setNow(f.current()!.progress.recoveryUntil)
    await f.recover()
    expect(f.current()!.progress.status).toBe('expired')
    expect(f.counts.admission).toBe(0)
  } finally {
    await f.dispose()
  }
})
it('rejects a promised reservation before retaining any financial intent', async () => {
  const { e, f } = coordinatedEvidence()
  const reserve = e.owner.reserve.bind(e.owner)
  e.owner.reserve = (...args) => {
    reserve(...args)
    return Promise.reject(new Error('Deferred reservation result')) as never
  }
  const coordinator = new PrivatePurchaseCoordinator(f.owner)
  try {
    await expect(coordinator.prepare(f.f.f.f.request, f.caller)).rejects.toMatchObject({
      code: 'context-changed'
    })
    expect(f.current()).toBeUndefined()
    expect(f.counts.admission).toBe(0)
  } finally {
    await coordinator.stop()
    await f.dispose()
  }
})

/** Interpose on a native read at the installed port boundary, without changing durable custody. */
function proofReadBoundary(retained = false) {
  const f = purchaseEvidenceFixture(),
    ledger = f.base.owner.domain.ledger,
    native = ledger.read.bind(ledger)
  let transform: (rows: Array<ProtectedLedgerRecord | undefined>) => void = () => {}
  jest.spyOn(ledger, 'read').mockImplementation((...args) => {
    const read = native(...args),
      records = Array.from(read.records, record =>
        record === undefined ? undefined : structuredClone(record)
      )
    transform(records)
    return { ...read, records }
  })
  const owner = new SQLitePrivatePurchaseEvidence(
    f.base.owner.domain,
    f.base.f.f.contracts,
    f.limits
  )
  owner.reserve(f.original, f.base.clock, f.base.guard)
  if (retained) {
    owner
      .propose(f.original, f.candidate, f.base.clock, f.base.guard)
      .retain(f.base.clock, f.base.guard)
  }
  return {
    ...f,
    owner,
    alter: (next: typeof transform) => {
      transform = next
    }
  }
}

it.each(['nonnumeric', 'fraction', 'negative', 'over-budget'])(
  'rejects an inconsistent %s native completion count',
  field => {
    const f = proofReadBoundary(),
      changes = { nonnumeric: '0', fraction: 0.5, negative: -1, 'over-budget': 5 }
    f.alter(rows => {
      rows[0]!.value.updates = changes[field as keyof typeof changes]
    })
    expect(() => f.owner.read(f.original, f.base.clock, f.base.guard)).toThrow(
      expect.objectContaining({
        code: 'unavailable',
        message: 'Invalid purchase proof update count'
      })
    )
  }
)

it.each(['header-format', 'binding', 'missing-chunk', 'header-bytes', 'header-updates'])(
  'rejects inconsistent native proof %s metadata before returning a candidate',
  field => {
    const f = proofReadBoundary()
    f.alter(rows => {
      const header = rows[0]!
      if (field === 'header-format') header.value.format = 'another-proof'
      if (field === 'binding') {
        header.value.binding = {
          ...(header.value.binding as object),
          acquisitionId: 'ee'.repeat(32)
        }
      }
      if (field === 'missing-chunk') rows[1] = undefined
      if (field === 'header-bytes') header.reservedBytes++
      if (field === 'header-updates') header.reservedUpdates--
    })
    let message = 'Purchase proof completion budget changed'
    if (field === 'header-format' || field === 'binding') message = 'Purchase proof binding changed'
    if (field === 'missing-chunk') message = 'Original purchase proof custody is missing'
    const code =
      field === 'header-format' || field === 'binding' ? 'context-changed' : 'unavailable'
    expect(() => f.owner.read(f.original, f.base.clock, f.base.guard)).toThrow(
      expect.objectContaining({ code, message })
    )
  }
)

it.each(['format', 'index', 'type', 'length', 'revision', 'updates', 'bytes'])(
  'checks a restored native proof chunk %s against its complete generation',
  field => {
    const f = proofReadBoundary()
    f.alter(rows => {
      const chunk = rows[1]!
      if (field === 'format') chunk.value.format = 'another-proof'
      if (field === 'index') chunk.value.index = 0
      if (field === 'type') chunk.value.data = []
      if (field === 'length') chunk.value.data = 'x'.repeat(196609)
      if (field === 'revision') chunk.revision = '2'
      if (field === 'updates') chunk.reservedUpdates--
      if (field === 'bytes') chunk.reservedBytes++
    })
    expect(() => f.owner.read(f.original, f.base.clock, f.base.guard)).toThrow(
      expect.objectContaining({
        code: 'unavailable',
        message: 'Purchase proof chunk differs from its native generation'
      })
    )
  }
)

it.each(['data', 'txid', 'digest'])(
  'refuses uncommitted %s in an empty proof reservation',
  field => {
    const f = proofReadBoundary()
    f.alter(rows => {
      if (field === 'data') rows[1]!.value.data = 'AA=='
      if (field === 'txid') rows[0]!.value.txid = 'ee'.repeat(32)
      if (field === 'digest') rows[0]!.value.digest = 'ee'.repeat(32)
    })
    expect(() => f.owner.read(f.original, f.base.clock, f.base.guard)).toThrow(
      expect.objectContaining({
        code: 'unavailable',
        message: 'Empty purchase proof custody differs'
      })
    )
  }
)

it.each(['acquisition', 'txid', 'digest'])(
  'binds every recovered candidate to its original %s commitment',
  field => {
    const f = proofReadBoundary(true)
    f.alter(rows => {
      const candidate = structuredClone(f.candidate)
      if (field === 'acquisition') candidate.acquisitionId = 'ee'.repeat(32)
      if (field === 'txid') candidate.txid = 'ee'.repeat(32)
      const text = canonicalOutputJSON(candidate)
      rows[1]!.value.data = Utils.toBase64(Utils.toArray(text, 'utf8'))
      rows[0]!.value.digest =
        field === 'digest' ? 'ee'.repeat(32) : Utils.toHex(Hash.sha256(Utils.toArray(text, 'utf8')))
    })
    expect(() => f.owner.read(f.original, f.base.clock, f.base.guard)).toThrow(
      expect.objectContaining({
        code: 'unavailable',
        message: 'Retained purchase proof differs from its commitment'
      })
    )
  }
)

it('refuses partial native reservation without committing any replacement header', () => {
  const f = purchaseEvidenceFixture(),
    domain = f.base.owner.domain,
    address = domain.identity.address('candidate', {
      purpose: 'private-purchase-evidence/1',
      acquisitionId: f.original.terms.body.acquisitionId,
      index: 1
    }),
    read = domain.ledger.read([address], f.base.clock, f.base.guard)
  domain.ledger.commit(
    read.revision,
    [
      {
        ...address,
        expectedRevision: null,
        reservedBytes: 197632,
        reservedUpdates: f.limits.maximumUpdates,
        value: { format: 'private-purchase-evidence/1', index: 1, data: '' }
      }
    ],
    f.base.clock,
    f.base.guard
  )
  const commit = jest.spyOn(domain.ledger, 'commit'),
    owner = new SQLitePrivatePurchaseEvidence(domain, f.base.f.f.contracts, f.limits)
  expect(() => owner.reserve(f.original, f.base.clock, f.base.guard)).toThrow(
    'Purchase proof custody is partial'
  )
  expect(commit).not.toHaveBeenCalled()
})

it.each(['read', 'commit', 'address', 'original', 'id', 'ledger', 'identity'])(
  'fences a replaced proof-owner %s before reading or retaining custody',
  boundary => {
    const f = purchaseEvidenceFixture(),
      domain = f.base.owner.domain,
      cases = {
        read: [domain.ledger, 'read'],
        commit: [domain.ledger, 'commit'],
        address: [domain.identity, 'address'],
        original: [f.base.f.f.contracts, 'original'],
        id: [f.owner, 'id'],
        ledger: [domain, 'ledger'],
        identity: [domain, 'identity']
      } as const,
      [object, key] = cases[boundary as keyof typeof cases],
      descriptor = Object.getOwnPropertyDescriptor(object, key),
      value = Reflect.get(object, key)
    let replacement: unknown = 'ee'.repeat(32)
    if (typeof value === 'function') {
      replacement = (...args: unknown[]) => Reflect.apply(value, object, args)
    } else if (typeof value === 'object') replacement = new Proxy(value, {})
    Object.defineProperty(object, key, { configurable: true, writable: true, value: replacement })
    try {
      expect(() => f.owner.read(f.original, f.base.clock, f.base.guard)).toThrow(
        expect.objectContaining({
          code: 'context-changed',
          message: 'Purchase evidence installation changed'
        })
      )
    } finally {
      if (descriptor) Object.defineProperty(object, key, descriptor)
      else Reflect.deleteProperty(object, key)
    }
  }
)

it('requires synchronous proof guards before opening native reads and drains a returned rejection', () => {
  const f = purchaseEvidenceFixture()
  for (const guard of [null, async () => {}]) {
    expect(() => f.owner.reserve(f.original, f.base.clock, guard as never)).toThrow(
      'Purchase proof guard must be synchronous'
    )
  }
  expect(() =>
    f.owner.reserve(f.original, f.base.clock, (() =>
      Promise.reject(new Error('deferred proof reservation'))) as never)
  ).toThrow(
    expect.objectContaining({
      code: 'context-changed',
      message: 'Purchase proof guard did not complete synchronously'
    })
  )
  expect(() => f.owner.read(f.original, f.base.clock, f.base.guard)).toThrow('missing')
})

it('requires the complete explicit target and all dependencies before proposing proof custody', () => {
  const f = purchaseEvidenceFixture()
  f.owner.reserve(f.original, f.base.clock, f.base.guard)
  const targetOnly = Beef.fromBinaryStrict(f.first.toBinary())
  targetOnly.txs = targetOnly.txs.filter(row => row.txid === f.candidate.txid)
  const absent = new Beef()
  absent.mergeTransaction(f.target.inputs[0].sourceTransaction!)
  for (const beef of [targetOnly, absent]) {
    expect(() =>
      f.owner.propose(
        f.original,
        {
          ...f.candidate,
          beef: Utils.toBase64(beef.toBinary())
        },
        f.base.clock,
        f.base.guard
      )
    ).toThrow(
      expect.objectContaining({
        code: 'unavailable',
        message: 'Complete purchase proof is required'
      })
    )
  }
  expect(f.owner.read(f.original, f.base.clock, f.base.guard).candidate).toBeNull()
})

it('refuses a complete alternative transaction before merging its proof into an existing purchase', () => {
  const f = purchaseEvidenceFixture()
  f.owner.reserve(f.original, f.base.clock, f.base.guard)
  f.owner
    .propose(f.original, f.candidate, f.base.clock, f.base.guard)
    .retain(f.base.clock, f.base.guard)
  const transaction = Transaction.fromHex(f.target.toHex())
  transaction.inputs[0].sourceTransaction = f.target.inputs[0].sourceTransaction
  transaction.addOutput({ satoshis: 0, lockingScript: LockingScript.fromHex('51') })
  const beef = new Beef()
  beef.mergeTransaction(transaction)
  expect(() =>
    f.owner.propose(
      f.original,
      {
        ...f.candidate,
        txid: transaction.id('hex'),
        beef: Utils.toBase64(beef.toBinaryAtomic(transaction.id('hex')))
      },
      f.base.clock,
      f.base.guard
    )
  ).toThrow(
    expect.objectContaining({
      code: 'conflict',
      message: 'Purchase proofs name different transactions'
    })
  )
  expect(f.owner.read(f.original, f.base.clock, f.base.guard).candidate).toEqual(f.candidate)
})

it('preserves the explicit evidence-owner format, scope and sealed limits in its identity', () => {
  const f = purchaseEvidenceFixture()
  expect(f.owner.id).toBe(
    outputPacketDigest('purchase', {
      purpose: 'private-purchase-evidence/1',
      scope: f.base.owner.domain.scope,
      limits: f.limits
    })
  )
})

it('binds retained proof to the complete original signed preparation even for the same acquisition', () => {
  const f = purchaseEvidenceFixture()
  f.owner.reserve(f.original, f.base.clock, f.base.guard)
  const contract = f.base.f.f
  contract.terms.purchaseUntil = '99'
  const changed = contract.original()
  expect(changed.terms.body.acquisitionId).toBe(f.original.terms.body.acquisitionId)
  expect(changed.terms.body.requestDigest).toBe(f.original.terms.body.requestDigest)
  expect(changed.terms.body.purchaseUntil).not.toBe(f.original.terms.body.purchaseUntil)
  expect(() => f.owner.read(changed, f.base.clock, f.base.guard)).toThrow(
    expect.objectContaining({ code: 'context-changed', message: 'Purchase proof binding changed' })
  )
  expect(f.owner.read(f.original, f.base.clock, f.base.guard).candidate).toBeNull()
})

it('requires callable evidence capabilities when installing the native owner', () => {
  const f = purchaseEvidenceFixture(),
    ledger = f.base.owner.domain.ledger,
    descriptor = Object.getOwnPropertyDescriptor(ledger, 'read')
  Object.defineProperty(ledger, 'read', { configurable: true, value: null })
  try {
    expect(
      () => new SQLitePrivatePurchaseEvidence(f.base.owner.domain, f.base.f.f.contracts, f.limits)
    ).toThrow('Purchase evidence capability required')
  } finally {
    if (descriptor) Object.defineProperty(ledger, 'read', descriptor)
    else Reflect.deleteProperty(ledger, 'read')
  }
})
