import { afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals'
import { createSecretKey } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fork, type ChildProcess } from 'node:child_process'
import { canonicalOutputJSON, outputPacketDigest, PrivateKey } from '@bsv/sdk'
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
  function location(
    maximumRecords = 128,
    maximumReservedBytes = 2 * 1048576,
    identity: PrivateServiceDomainConfiguration['identity'] = { seller: f.seller, chain: f.chain }
  ) {
    const directory = mkdtempSync(join(tmpdir(), 'acquisition-index-')),
      path = join(directory, 'private.db')
    const config: PrivateServiceDomainConfiguration = {
      identity,
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

  it.each(['seller', 'chain'] as const)(
    'refuses a genuine native owner in another %s namespace',
    field => {
      const identity = {
          seller: field === 'seller' ? new PrivateKey(49).toPublicKey().toString() : f.seller,
          chain: field === 'chain' ? { ...f.chain, network: 'another-native-chain' } : f.chain
        },
        { owner } = location(128, 2 * 1048576, identity),
        index = new PrivateAcquisitionFundingIndex(owner),
        expected = expect.objectContaining({
          code: 'context-changed',
          message: 'Acquisition funding namespace differs'
        })
      expect(() => index.reserveQuote(f.initial())).toThrow(expected)
      expect(() => index.assign(f.reserved(), '0', clock, allow)).toThrow(expected)
      expect(owner.ledger.enumerate('funding-fence', null, 64, clock, allow).entries).toEqual([])
    }
  )

  it.each([
    ['format', 'Unknown retained funding fence cannot establish uniqueness'],
    ['kind', 'Retained funding fence binding differs'],
    ['key', 'Retained funding fence binding differs'],
    ['capacity', 'Retained funding fence binding differs'],
    ['completion', 'Funding slot completion capacity differs'],
    ['missing', 'Reserved funding slot is unavailable'],
    ['request', 'Acquisition funding slot changed request'],
    ['duplicate', 'Acquisition funding slot changed request'],
    ['assignment-chain', 'Retained funding assignment differs'],
    ['assignment-operation', 'Retained funding assignment differs'],
    ['assignment-completion', 'Funding slot completion capacity differs'],
    ['different-assignment', 'Acquisition already reserved different funding']
  ] as const)(
    'refuses negative ledger read DATA for %s after an actual native read',
    (field, message) => {
      const { owner } = location(),
        index = new PrivateAcquisitionFundingIndex(owner),
        state = f.reserved(),
        operation = state.funding!.operation
      let current = reserve(owner, f.initial())
      if (field.startsWith('assignment-') || field === 'different-assignment')
        current = owner.ledger.commit(
          current,
          [index.assign(state, current, clock, allow)!],
          clock,
          allow
        )
      const ledger = owner.ledger,
        addresses = ledger
          .enumerate('funding-fence', null, 64, clock, allow)
          .entries.map(({ kind, key }) => ({ kind, key })),
        actual = ledger.read.bind(ledger),
        original = actual(addresses, clock, allow),
        changed = jest.spyOn(ledger, 'read').mockImplementation((...args) => {
          const result = actual(...args),
            row = result.records[0]!
          if (field === 'format') row.value.format = 'future'
          if (field === 'kind') row.kind = 'quote'
          if (field === 'key') row.key = 'ef'.repeat(32)
          if (field === 'capacity') row.reservedBytes--
          if (field === 'completion') row.reservedUpdates = 0
          if (field === 'request') row.value.requestDigest = 'ef'.repeat(32)
          if (field === 'assignment-completion') row.reservedUpdates = 1
          if (field === 'assignment-operation')
            row.value.assignment = { operationId: 'ef'.repeat(32), funding: operation.funding }
          if (field === 'assignment-chain' || field === 'different-assignment') {
            const funding = {
              ...operation.funding,
              ...(field === 'assignment-chain'
                ? { chain: { ...operation.funding.chain, network: 'foreign' } }
                : { outputIndex: operation.funding.outputIndex + 1 })
            }
            row.value.assignment = {
              operationId: outputPacketDigest('wallet-funding', {
                seller: f.seller,
                acquisitionId: state.challenge.acquisitionId,
                funding
              }),
              funding
            }
          }
          return {
            ...result,
            records:
              field === 'missing'
                ? [undefined]
                : field === 'duplicate'
                  ? [row, structuredClone(row)]
                  : [row]
          }
        })
      try {
        expect(() => index.assign(state, current, clock, allow)).toThrow(
          expect.objectContaining({
            code: field === 'different-assignment' ? 'conflict' : 'unavailable',
            message
          })
        )
        expect(changed).toHaveBeenCalledTimes(1)
      } finally {
        changed.mockRestore()
      }
      expect(ledger.read(addresses, clock, allow)).toEqual(original)
    }
  )

  it.each(['scan', 'read'] as const)(
    'rejects a changed %s revision after its actual native operation',
    phase => {
      const { owner } = location(),
        index = new PrivateAcquisitionFundingIndex(owner)
      reserve(owner, f.initial())
      const ledger = owner.ledger,
        enumerate = ledger.enumerate.bind(ledger),
        read = ledger.read.bind(ledger)
      const changed =
        phase === 'scan'
          ? jest
              .spyOn(ledger, 'enumerate')
              .mockImplementation((...args) => ({ ...enumerate(...args), revision: '0' }))
          : jest
              .spyOn(ledger, 'read')
              .mockImplementation((...args) => ({ ...read(...args), revision: '0' }))
      try {
        expect(() => index.assign(f.reserved(), '1', clock, allow)).toThrow(
          expect.objectContaining({
            code: 'conflict',
            message: 'Funding namespace changed during ' + phase
          })
        )
        expect(changed).toHaveBeenCalledTimes(1)
      } finally {
        changed.mockRestore()
      }
      expect(revision(owner)).toBe('1')
    }
  )

  it('refuses an over-capacity enumerator DATA result without reading or modifying native records', () => {
    const { owner } = location(),
      index = new PrivateAcquisitionFundingIndex(owner)
    reserve(owner, f.initial())
    const ledger = owner.ledger,
      actual = ledger.enumerate.bind(ledger),
      changed = jest.spyOn(ledger, 'enumerate').mockImplementation((...args) => {
        const page = actual(...args)
        return { ...page, entries: Array.from({ length: 4097 }, () => page.entries[0]!) }
      }),
      read = jest.spyOn(ledger, 'read')
    try {
      expect(() => index.assign(f.reserved(), '1', clock, allow)).toThrow(
        expect.objectContaining({
          code: 'limited',
          message: 'Funding namespace exceeds native domain capacity'
        })
      )
      expect(read).not.toHaveBeenCalled()
    } finally {
      changed.mockRestore()
      read.mockRestore()
    }
    expect(revision(owner)).toBe('1')
  })
})
