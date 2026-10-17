import { afterEach, beforeAll, describe, expect, it } from '@jest/globals'
import { createSecretKey } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fork, type ChildProcess } from 'node:child_process'
import { canonicalOutputJSON, outputPacketDigest } from '@bsv/sdk'
import {
  PrivateServiceDomain,
  type PrivateServiceDomainConfiguration
} from '../src/private/PrivateServiceDomain.js'
import { NodeProtectedPayloadCodec } from '../src/private/NodeProtectedPayloadCodec.js'
import { PrivateAcquisitionFundingIndex } from '../src/private/PrivateAcquisitionFundingIndex.js'
import {
  advancePrivateAcquisitionProgress as advance,
  createPrivateAcquisitionProgress as create,
  type PrivateAcquisitionProgress
} from '../src/private/PrivateAcquisitionProgress.js'
import { acquisitionFixture } from './private-acquisition.fixture.js'

describe('native acquisition funding reservation index', () => {
  let f: Awaited<ReturnType<typeof acquisitionFixture>>
  beforeAll(async () => {
    f = await acquisitionFixture()
  })
  const cleanup = new Set<() => void>(),
    clock = () => '30',
    allow = () => {}
  afterEach(() => {
    for (const close of cleanup) close()
    cleanup.clear()
  })
  function location(maximumRecords = 128, maximumReservedBytes = 2 * 1048576) {
    const directory = mkdtempSync(join(tmpdir(), 'acquisition-index-')),
      path = join(directory, 'private.db')
    const config: PrivateServiceDomainConfiguration = {
      identity: { seller: f.seller, chain: f.chain },
      indexKeyId: 'index',
      capacity: {
        storeId: 'ab'.repeat(32),
        maximumRecords,
        maximumRecordBytes: 8192,
        maximumReservedBytes
      },
      application: { test: 'acquisition-index-only' }
    }
    const indexKey = createSecretKey(Buffer.alloc(32, 91)),
      payloadKey = createSecretKey(Buffer.alloc(32, 92))
    const owners: PrivateServiceDomain[] = []
    function open(create = false) {
      const owner = PrivateServiceDomain[create ? 'create' : 'open'](
        path,
        config,
        { resolve: () => indexKey },
        new NodeProtectedPayloadCodec({ resolve: () => payloadKey }, 'payload')
      )
      owners.push(owner)
      return owner
    }
    cleanup.add(() => {
      for (const owner of owners) owner.close()
      rmSync(directory, { recursive: true, force: true })
    })
    const owner = open(true)
    return { owner, open, path, config, directory }
  }
  function quote(id: string) {
    const request = { ...f.request, requestId: `acquisition-test-${id}` }
    const challenge = {
      ...f.challenge,
      requestDigest: outputPacketDigest('acquire-request', request),
      acquisitionId: outputPacketDigest('acquisition', {
        chain: f.chain,
        seller: f.seller,
        buyer: f.buyer,
        service: request.service,
        requestId: `acquisition-test-${id}`
      })
    }
    return create(request, challenge, f.selected, '1')
  }
  function pending(state = f.initial()) {
    state = advance(state, { type: 'pin', payment: f.payment() }, '20')
    return advance(
      state,
      {
        type: 'reserve-funding',
        candidateDigest: state.candidate!.digest,
        sellerPaymentKey: f.sellerPaymentKey,
        acceptance: {
          chain: f.chain,
          txid: f.transaction.id('hex'),
          policy: { kind: 'local-admission' },
          acceptedAt: '19'
        }
      },
      '21'
    )
  }
  function revision(owner: PrivateServiceDomain) {
    return owner.ledger.enumerate('funding-fence', null, 1, clock, allow).revision
  }
  function reserve(owner: PrivateServiceDomain, state: PrivateAcquisitionProgress) {
    const index = new PrivateAcquisitionFundingIndex(owner)
    return owner.ledger.commit(revision(owner), [index.reserveQuote(state)], clock, allow)
  }

  it('reserves completion before a quote, and assigns at full record/byte capacity', () => {
    const { owner } = location(1, 8192),
      index = new PrivateAcquisitionFundingIndex(owner)
    const current = reserve(owner, f.initial())
    expect(() => reserve(owner, quote('no-room'))).toThrow(
      expect.objectContaining({ code: 'limited' })
    )
    const change = index.assign(f.reserved(), current, clock, allow)!
    expect(change).toMatchObject({ expectedRevision: '1', reservedBytes: 8192, reservedUpdates: 0 })
    const committed = owner.ledger.commit(current, [change], clock, allow)
    expect(index.assign(f.reserved(), committed, clock, allow)).toBeNull()
    expect(
      owner.ledger.read([{ kind: change.kind, key: change.key }], clock, allow).records[0]!.value
    ).toMatchObject({ assignment: { operationId: f.reserved().funding!.operation.id } })
  })
  it('refuses the same funding output for another acquisition after native reopen', () => {
    const place = location(),
      index = new PrivateAcquisitionFundingIndex(place.owner),
      a = quote('one'),
      b = quote('two')
    reserve(place.owner, a)
    const current = reserve(place.owner, b),
      change = index.assign(pending(a), current, clock, allow)!
    place.owner.ledger.commit(current, [change], clock, allow)
    place.owner.close()
    const reopened = place.open(),
      other = new PrivateAcquisitionFundingIndex(reopened)
    expect(() => other.assign(pending(b), revision(reopened), clock, allow)).toThrow(
      expect.objectContaining({ code: 'conflict' })
    )
    expect(other.assign(pending(a), revision(reopened), clock, allow)).toBeNull()
  })
  it('requires an atomic revision with the owner state and rejects racing native commits', () => {
    const place = location(),
      index = new PrivateAcquisitionFundingIndex(place.owner),
      second = place.open()
    const a = quote('one'),
      b = quote('two')
    reserve(place.owner, a)
    const current = reserve(place.owner, b)
    const first = index.assign(pending(a), current, clock, allow)!
    const secondChange = new PrivateAcquisitionFundingIndex(second).assign(
      pending(b),
      current,
      clock,
      allow
    )!
    place.owner.ledger.commit(current, [first], clock, allow)
    expect(() => second.ledger.commit(current, [secondChange], clock, allow)).toThrow(
      expect.objectContaining({ code: 'conflict' })
    )
    expect(() =>
      new PrivateAcquisitionFundingIndex(second).assign(pending(b), revision(second), clock, allow)
    ).toThrow(expect.objectContaining({ code: 'conflict' }))
    expect(
      place.owner.ledger.read([{ kind: secondChange.kind, key: secondChange.key }], clock, allow)
        .records[0]!.value.assignment
    ).toBeNull()
  })
  it('allows only one separate process to claim a shared funding outpoint', async () => {
    const place = location(),
      a = quote('process-one'),
      b = quote('process-two')
    reserve(place.owner, a)
    reserve(place.owner, b)
    const children: ChildProcess[] = []
    const wait = (child: ChildProcess, phase: string) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => {
          clean()
          reject(new Error('Funding child timed out'))
        }, 10000)
        const error = (cause: Error) => {
          clean()
          reject(cause)
        }
        const exit = () => {
          clean()
          reject(new Error('Funding child exited before response'))
        }
        const message = (value: unknown) => {
          if (value && typeof value === 'object' && 'phase' in value && value.phase === phase) {
            clean()
            resolve(value as Record<string, unknown>)
          }
        }
        function clean() {
          clearTimeout(timer)
          child.off('error', error)
          child.off('exit', exit)
          child.off('message', message)
        }
        child.on('error', error)
        child.on('exit', exit)
        child.on('message', message)
      })
    try {
      for await (const state of [pending(a), pending(b)]) {
        const child = fork(
          fileURLToPath(
            new URL('./fixtures/private-acquisition-funding-worker.mjs', import.meta.url)
          ),
          [],
          { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }
        )
        children.push(child)
        const ready = wait(child, 'ready')
        child.send({ path: place.path, config: place.config, state })
        expect(await ready).toEqual({ phase: 'ready', revision: '2' })
      }
      const results = children.map(child => wait(child, 'settled'))
      for (const child of children) child.send('commit')
      expect(
        (await Promise.all(results))
          .map(result => {
            if (result.outcome !== 'committed' && result.outcome !== 'conflict')
              throw new Error('Unexpected native funding worker outcome')
            return result.outcome
          })
          .sort((left, right) => Number(left > right) - Number(left < right))
      ).toEqual(['committed', 'conflict'])
      const entries = place.owner.ledger.enumerate('funding-fence', null, 64, clock, allow)
      expect(entries.revision).toBe('3')
      const records = place.owner.ledger.read(
        entries.entries.map(({ kind, key }) => ({ kind, key })),
        clock,
        allow
      )
      expect(records.records.filter(row => row!.value.assignment !== null)).toHaveLength(1)
    } finally {
      await Promise.all(
        children.map(async child => {
          if (child.exitCode !== null || child.signalCode !== null) return
          await new Promise<void>(resolve => {
            child.once('exit', () => resolve())
            child.kill('SIGKILL')
          })
        })
      )
    }
  }, 30000)
  it('covers every page before reserving and finds a duplicate after the first page', () => {
    const { owner } = location(),
      index = new PrivateAcquisitionFundingIndex(owner)
    const quotes = Array.from({ length: 70 }, (_, i) => quote(`page-${i}`))
    const changes = quotes.map(state => index.reserveQuote(state))
    owner.ledger.commit('0', changes.slice(0, 64), clock, allow)
    let current = owner.ledger.commit('1', changes.slice(64), clock, allow)
    const ordered = [...changes].sort((a, b) => a.key.localeCompare(b.key))
    const late = quotes.find(state => index.reserveQuote(state).key === ordered[69].key)!
    const other = quotes.find(
      state => state.challenge.acquisitionId !== late.challenge.acquisitionId
    )!
    const change = index.assign(pending(late), current, clock, allow)!
    current = owner.ledger.commit(current, [change], clock, allow)
    expect(() => index.assign(pending(other), current, clock, allow)).toThrow(
      expect.objectContaining({ code: 'conflict' })
    )
  })
  it('fails closed on an unknown or mismatched retained funding slot', () => {
    const { owner } = location(),
      index = new PrivateAcquisitionFundingIndex(owner)
    reserve(owner, f.initial())
    const address = owner.identity.address('funding-fence', { purpose: 'another-format' })
    owner.ledger.commit(
      '1',
      [
        {
          ...address,
          expectedRevision: null,
          reservedBytes: 8192,
          reservedUpdates: 1,
          value: {
            format: 'future',
            acquisitionId: '11'.repeat(32),
            requestDigest: '22'.repeat(32),
            assignment: null
          }
        }
      ],
      clock,
      allow
    )
    expect(() => index.assign(f.reserved(), '2', clock, allow)).toThrow(
      expect.objectContaining({ code: 'unavailable' })
    )
  })
  it('never treats a missing reserved slot or stale revision as permission to create one', () => {
    const { owner } = location(),
      index = new PrivateAcquisitionFundingIndex(owner)
    expect(() => index.assign(f.reserved(), '0', clock, allow)).toThrow(
      expect.objectContaining({ code: 'unavailable' })
    )
    reserve(owner, f.initial())
    expect(() => index.assign(f.reserved(), '0', clock, allow)).toThrow(
      expect.objectContaining({ code: 'conflict' })
    )
    expect(() => index.reserveQuote(f.pinned())).toThrow()
    expect(() => index.assign(f.initial(), '1', clock, allow)).toThrow()
  })
  it('keeps current authority at scan and commit and leaves the reserved slot intact on refusal', () => {
    const { owner } = location(),
      index = new PrivateAcquisitionFundingIndex(owner)
    reserve(owner, f.initial())
    const deny = () => {
      throw new Error('Access revoked')
    }
    expect(() => index.assign(f.reserved(), '1', clock, deny)).toThrow('Access revoked')
    const change = index.assign(f.reserved(), '1', clock, allow)!
    expect(() => owner.ledger.commit('1', [change], clock, deny)).toThrow('Access revoked')
    expect(
      owner.ledger.read([{ kind: change.kind, key: change.key }], clock, allow).records[0]!.value
        .assignment
    ).toBeNull()
  })
  it('keeps buyer/service and payment details out of plaintext addresses', () => {
    const { owner } = location(),
      index = new PrivateAcquisitionFundingIndex(owner),
      change = index.reserveQuote(f.initial())
    expect(change.key).toMatch(/^[0-9a-f]{64}$/)
    expect(change.key).not.toBe(f.challenge.acquisitionId)
    expect(canonicalOutputJSON({ kind: change.kind, key: change.key })).not.toContain(f.buyer)
  })
})
