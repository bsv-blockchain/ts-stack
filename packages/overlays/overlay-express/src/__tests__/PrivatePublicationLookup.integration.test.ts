import express, { type Request, type Response } from 'express'
import { rateLimit } from 'express-rate-limit'
import { afterAll, beforeAll, expect, it } from '@jest/globals'
import { guardAuthenticatedResponse } from '@bsv/auth-express-middleware'
import {
  validateOutputLookupContinuation,
  canonicalOutputJSON,
  parseOutputJSON,
  PrivateKey,
  Transaction,
  Utils
} from '@bsv/sdk'
import { OverlayGASPStorage } from '@bsv/overlay/GASP/OverlayGASPStorage.ts'
import { PrivatePublicationLookupContext } from '../../../../application/output-knowledge/src/private/PrivatePublicationLookupContext.js'
import { PrivatePublicationCoordinator } from '../../../../application/output-knowledge/src/private/PrivatePublicationCoordinator.js'
import {
  providerFixture,
  providerBatch,
  providerRead
} from '../../../../application/output-knowledge/test/lookup-provider-fixture.js'
import { collectionOutputIndexKey } from '../../../../application/output-knowledge/src/lookup/CollectionOutputQueryPolicy.js'
import { privatePublicationEngineFixture } from './PrivatePublicationEngine.fixture.js'
import { privatePublicationHTTPFixture } from './PrivatePublicationRoutes.fixture.js'

let replica: Awaited<ReturnType<typeof privatePublicationEngineFixture>>
beforeAll(async () => {
  replica = await privatePublicationEngineFixture()
}, 120000)
afterAll(async () => {
  await replica?.close()
}, 60000)
const fixedControl = canonicalOutputJSON({
  version: 1,
  error: { code: 'not-found', message: 'Private lookup unavailable', retryable: false }
})
const controlHeaders = {
  'content-type': 'application/json',
  'cache-control': 'private, no-store',
  'x-content-type-options': 'nosniff'
}

it('proves original off-chain plumbing, authorized legacy context, native restart, final signing revocation and public replay/GASP non-disclosure', async () => {
  let actual: Awaited<ReturnType<typeof replica.install>> | undefined,
    coordinator: PrivatePublicationCoordinator | undefined,
    reader: PrivatePublicationLookupContext | undefined,
    readerOptions: ConstructorParameters<typeof PrivatePublicationLookupContext>[0] | undefined,
    setGrant: ((value: boolean) => void) | undefined,
    preparedForSigning = false,
    maps = 0
  const recipient = new PrivateKey(64).toPublicKey().toString()
  const f = await privatePublicationHTTPFixture(
    async owner => {
      actual = await replica.install(owner, 'private-context-real-lookup')
      coordinator = new PrivatePublicationCoordinator({
        ...owner.options,
        admission: actual.bridge
      })
      return { service: coordinator }
    },
    false,
    (app, authenticate, owner) => {
      const grant = owner.native.owner.identity.address('rules', {
        purpose: 'lookup-entitlement',
        recipient
      })
      const grantSnapshot = owner.native.owner.ledger.read([grant], owner.options.clock, () => {})
      owner.native.owner.ledger.commit(
        grantSnapshot.revision,
        [
          {
            ...grant,
            expectedRevision: null,
            reservedBytes: 1024,
            reservedUpdates: 4,
            value: { allowed: true }
          }
        ],
        owner.options.clock,
        () => {}
      )
      setGrant = value => {
        const peer = owner.reopenWithDomain().owner,
          current = peer.ledger.read([grant], owner.options.clock, () => {}),
          record = current.records[0]!
        peer.ledger.commit(
          current.revision,
          [
            {
              ...grant,
              expectedRevision: record.revision,
              reservedBytes: record.reservedBytes,
              reservedUpdates: record.reservedUpdates - 1,
              value: { allowed: value }
            }
          ],
          owner.options.clock,
          () => {}
        )
      }
      readerOptions = {
        domain: owner.native.owner,
        store: owner.store,
        topic: owner.contract.installation.topic,
        lookup: owner.service.lookup,
        clock: owner.options.clock,
        authorize: (_reference, who, publisher, view) =>
          view.get(grant)?.value.allowed === true &&
          who === recipient &&
          publisher === owner.caller.publisher,
        mapContext: bytes => {
          maps++
          return bytes
        },
        maximumContextBytes: 64,
        maximumResponseBytes: 1048576
      }
      reader = new PrivatePublicationLookupContext(readerOptions)
      // Demonstration-only legacy BRC-101 service: no BRC-195 publication profile is claimed.
      // The shared public Engine registry never acquires the request-local context.
      app.post(
        '/private-context/lookup',
        rateLimit({ windowMs: 60000, limit: 600 }),
        express.raw({ type: 'application/json', limit: 1048576, inflate: false }),
        authenticate,
        (req: Request, res: Response) => {
          res.set(controlHeaders)
          const execute = async () => {
            const signal = new AbortController(),
              cancel = () => signal.abort()
            req.once('aborted', cancel)
            res.once('close', cancel)
            let prepared: ReturnType<PrivatePublicationLookupContext['prepare']> | undefined
            try {
              const identity = (req as Request & { auth?: { identityKey?: string } }).auth
                ?.identityKey
              if (!identity || identity === 'unknown' || !reader || !actual)
                throw new Error('Unauthenticated lookup')
              const query = parseOutputJSON(req.body)
              if (
                query === null ||
                typeof query !== 'object' ||
                Array.isArray(query) ||
                Object.keys(query).length !== 1 ||
                typeof query.publicationId !== 'string'
              )
                throw new Error('Invalid bounded lookup query')
              prepared = reader.prepare(query.publicationId, {
                recipient: identity,
                current: () => !signal.signal.aborted,
                signal: signal.signal
              })
              const hydrated = await actual.privateLookup(prepared.formula()),
                bound = prepared.bind(hydrated)
              preparedForSigning = true
              guardAuthenticatedResponse(res, async (candidate, enqueue, transportSignal) => {
                if (candidate.identityKey !== identity || transportSignal.aborted)
                  throw new Error('Private lookup transport changed')
                if (candidate.attempt !== 0) {
                  if (
                    candidate.statusCode !== 404 ||
                    new TextDecoder().decode(candidate.body) !== fixedControl
                  )
                    throw new Error('Private control bytes differ')
                  enqueue()
                  return
                }
                try {
                  if (
                    candidate.statusCode !== 200 ||
                    new TextDecoder().decode(candidate.body) !== bound.body
                  )
                    throw new Error('Private answer bytes changed')
                  bound.enqueue(() => {
                    if (transportSignal.aborted) throw new Error('Private lookup cancelled')
                    enqueue()
                  })
                } catch {
                  return {
                    statusCode: 404,
                    headers: controlHeaders,
                    body: new TextEncoder().encode(fixedControl)
                  }
                } finally {
                  prepared?.dispose()
                }
              })
              res.status(200).end(bound.body)
            } catch {
              prepared?.dispose()
              res.status(404).end(fixedControl)
            } finally {
              req.removeListener('aborted', cancel)
              res.removeListener('close', cancel)
            }
          }
          void execute().catch(() => res.destroy())
        }
      )
      app.post('/lookup', express.json(), (_req, res) => {
        void actual!.engine.lookup({ service: actual!.lookupName, query: {} }).then(
          answer => res.json(answer),
          () => res.status(503).end()
        )
      })
    }
  )
  const feed = await providerFixture()
  try {
    expect((await f.fetch('publish')).status).toBe(200)
    if (!actual || !coordinator || !readerOptions)
      throw new Error('Missing actual native installation')
    expect(actual.submissions).toBe(1)
    expect(actual.calls.some(call => JSON.stringify(call.privateValues) === '[1,2,3]')).toBe(true)
    // Atomic admission records durable external lookup intents, rather than running
    // legacy callbacks during commit. Private values remain in protected custody.
    expect(actual.lookupCalls).toHaveLength(0)
    const pendingLookup = await actual.storage.admission.claimOutbox('lookup')
    expect(pendingLookup?.target).toBe(actual.lookupName)
    expect(pendingLookup?.payloads.every(payload => payload.kind === 'raw-transaction')).toBe(true)
    const classic = await replica.install(f, 'private-context-legacy-hooks')
    await classic.legacyEngine().submit(
      {
        beef: Utils.toArray(f.contract.request.evidence.beef, 'base64'),
        topics: [f.contract.request.topic]
      },
      undefined,
      'historical-tx',
      [1, 2, 3]
    )
    expect(
      classic.lookupCalls.some(call => JSON.stringify(call.offChainValues) === '[1,2,3]')
    ).toBe(true)
    expect(classic.calls.some(call => JSON.stringify(call.privateValues) === '[1,2,3]')).toBe(true)
    expect(
      await classic.engine.lookup({ service: classic.lookupName, query: {} })
    ).not.toHaveProperty('privateValues')
    const publicAnswer = await (
      await fetch(f.origin + '/lookup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}'
      })
    ).json()
    expect(publicAnswer.outputs).toHaveLength(1)
    expect(publicAnswer.outputs[0]).not.toHaveProperty('context')
    const privateClient = f.clientFor(new PrivateKey(64)),
      query = { publicationId: f.status.publicationId }
    const lookup = () =>
      privateClient.fetch(f.origin + '/private-context/lookup', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
        body: JSON.stringify(query)
      })
    const response = await lookup()
    expect(response.status).toBe(200)
    const original = await response.json()
    expect(original.outputs[0].context).toEqual([1, 2, 3])
    expect(f.wireHeaders.at(-1)!.get('cache-control')).toBe('private, no-store')
    expect(Utils.toBase64(Transaction.fromBEEF(original.outputs[0].beef).toBinary())).toBe(
      f.contract.record.rawTransaction
    )
    const mapped = maps
    const wrong = await f
      .clientFor(new PrivateKey(65))
      .fetch(f.origin + '/private-context/lookup', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
        body: JSON.stringify(query)
      })
    expect(wrong.status).toBe(404)
    expect(await wrong.text()).toBe(fixedControl)
    expect(maps).toBe(mapped)
    preparedForSigning = false
    f.onHTTPSign(() => {
      if (preparedForSigning) setGrant!(false)
    })
    const refused = await lookup()
    expect(refused.status).toBe(404)
    expect(await refused.text()).toBe(fixedControl)
    expect(preparedForSigning).toBe(true)
    f.onHTTPSign(undefined)
    setGrant!(true)
    f.native.owner.close()
    const reopened = f.reopenWithDomain()
    reader = new PrivatePublicationLookupContext({
      ...readerOptions,
      domain: reopened.owner,
      store: reopened.store
    })
    const recovered = await lookup()
    expect(recovered.status).toBe(200)
    expect(await recovered.json()).toEqual(original)
    expect(actual.submissions).toBe(1)
    const publicOutput = await actual.storage.findOutput(
      f.contract.request.evidence.txid,
      0,
      f.contract.request.topic,
      undefined,
      true
    )
    expect(publicOutput).not.toHaveProperty('privateValues')
    const gasp = new OverlayGASPStorage(f.contract.request.topic, actual.engine)
    const historical = await gasp.hydrateGASPNode(
      f.contract.request.evidence.txid + '.0',
      f.contract.request.evidence.txid,
      0,
      true
    )
    expect(historical.rawTx).toBe(
      Utils.toHex(Utils.toArray(f.contract.record.rawTransaction, 'base64'))
    )
    expect(Object.keys(historical).sort()).toEqual(
      ['graphID', 'outputIndex', ...(historical.proof ? ['proof'] : []), 'rawTx'].sort()
    )
    const evidence = f.contract.request.evidence,
      key = collectionOutputIndexKey(evidence),
      head = await feed.index.head()
    const added = await feed.index.commit({
      base: head.sequence,
      evaluatedAt: feed.clock.now,
      edits: [
        {
          key,
          previous: null,
          next: {
            data: {
              collection: 'records',
              audience: 'public',
              output: {
                evidence: {
                  txid: evidence.txid,
                  outputIndex: evidence.outputIndex,
                  beef: evidence.beef
                }
              }
            },
            expiresAt: null
          }
        }
      ],
      event: { kind: 'public-discovery' }
    })
    const open = await feed.service.open(feed.open, feed.caller),
      first = providerBatch(open)
    expect(JSON.stringify(first)).not.toContain('"context"')
    expect(JSON.stringify(first)).not.toContain('"privateValues"')
    expect(await feed.service.open(feed.open, feed.caller)).toEqual(open)
    await feed.index.commit({
      base: added.sequence,
      evaluatedAt: feed.clock.now,
      edits: [{ key, previous: added.sequence, next: null }],
      event: { kind: 'public-source-withdrawal' }
    })
    const readRequest = providerRead(first),
      live = await feed.service.read(readRequest, feed.caller)
    expect(providerBatch(live).groups[0].observations[0].kind).toBe('withdraw')
    const replay = providerBatch(await feed.service.read(readRequest, feed.caller))
    const liveMeaning = { ...providerBatch(live), cursor: undefined },
      replayMeaning = { ...replay, cursor: undefined }
    expect(replayMeaning).toEqual(liveMeaning)
    validateOutputLookupContinuation(first, replay)
    // Opaque cursors may be resealed; complete observations and continuity do not change.
    expect(JSON.stringify(providerBatch(live))).not.toContain('"context"')
    expect(await actual.engine.lookup({ service: actual.lookupName, query: {} })).toEqual(
      publicAnswer
    )
  } finally {
    try {
      await coordinator?.stop()
    } finally {
      await feed.cleanup()
      await f.close()
    }
  }
}, 60000)
