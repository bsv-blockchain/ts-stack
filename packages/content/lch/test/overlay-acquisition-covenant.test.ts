import { expect, it } from '@jest/globals'
import { canonicalOutputJSON, Utils } from '@bsv/sdk'
import { ATOMIC_BEEF } from '@bsv/sdk/transaction/Beef'
import { WalletBRC78KeyDelivery, signObject, type KeyGrant } from '../src/index.js'
import { lchOverlayCovenantEntitlementDigest } from '../src/overlayAcquisitionCovenantEntitlement.js'
import { LCHOverlayCovenantDomain } from '../src/overlayAcquisitionCovenant.js'
import { lchNativeCovenantFixture } from './overlay-acquisition-covenant-native.fixture.js'

it('executes complete authorized Bitcoin and covenant purchase evidence before retaining playable rights', async () => {
  const f = await lchNativeCovenantFixture(),
    signal = new AbortController().signal
  await f.domain.preflight(f.prepare, f.prepared, signal)
  expect(f.counts).toEqual({ preparation: 1, purchase: 0, release: 0 })
  await expect(f.domain.playback(f.delivered, signal)).rejects.toThrow('not been locally verified')
  await f.domain.verify(f.prepare, f.prepared, f.submission, f.delivered, signal)
  expect(f.counts).toEqual({ preparation: 1, purchase: 1, release: 1 })
  expect(await f.domain.usable(f.delivered, signal)).toBe(true)
  expect(await f.domain.playback(f.delivered, signal)).toEqual(f.plaintext)
  expect(f.counts).toEqual({ preparation: 1, purchase: 1, release: 1 })
}, 60000)

it('retains playable rights after independently checking a complete plain BEEF purchase whose proof changes record order', async () => {
  const f = await lchNativeCovenantFixture({ provenPurchase: true }),
    signal = new AbortController().signal,
    packet = f.purchaseBEEF()
  expect(packet.atomicTxid).toBeUndefined()
  expect(packet.txs.at(-1)!.txid).not.toBe(f.submission.txid)
  expect(packet.findTransactionForSigning(f.submission.txid)!.toHex()).toBe(f.purchased.toHex())
  expect(packet.findAtomicTransaction(f.submission.txid)!.merklePath?.blockHeight).toBe(101)
  const wrongMarker = new Utils.Writer()
    .writeUInt32LE(ATOMIC_BEEF)
    .write(Utils.toArray('aa'.repeat(32), 'hex').reverse())
    .write(Utils.toArray(f.submission.beef, 'base64'))
    .toArray()
  await expect(
    f.domain.verify(
      f.prepare,
      f.prepared,
      { ...f.submission, beef: Utils.toBase64(wrongMarker) },
      f.delivered,
      signal
    )
  ).rejects.toThrow('Original wallet transaction')
  expect(f.counts).toEqual({ preparation: 0, purchase: 0, release: 0 })
  await f.domain.verify(f.prepare, f.prepared, f.submission, f.delivered, signal)
  expect(f.counts).toEqual({ preparation: 0, purchase: 1, release: 1 })
  expect(await f.domain.playback(f.delivered, signal)).toEqual(f.plaintext)
}, 60000)

it('owns prepared terms and wallet submission before the first asynchronous boundary', async () => {
  const f = await lchNativeCovenantFixture(),
    signal = new AbortController().signal,
    terms = JSON.parse(canonicalOutputJSON(f.prepared)) as typeof f.prepared
  const preflight = f.domain.preflight(f.prepare, terms, signal)
  terms.body.purchaseUntil = '1'
  await preflight
  const submission = { ...f.submission },
    verifying = f.domain.verify(f.prepare, f.prepared, submission, f.delivered, signal)
  submission.beef = 'AA=='
  await verifying
  expect(await f.domain.playback(f.delivered, signal)).toEqual(f.plaintext)
  expect(f.counts).toEqual({ preparation: 1, purchase: 1, release: 1 })
}, 60000)

it('refuses uninitialized custody and the wrong actual buyer wallet before funding', async () => {
  const f = await lchNativeCovenantFixture(),
    signal = new AbortController().signal,
    uninitialized = await LCHOverlayCovenantDomain.create(f.options)
  await expect(uninitialized.preflight(f.prepare, null, signal)).rejects.toThrow('not initialized')
  await expect(
    LCHOverlayCovenantDomain.create({ ...f.options, wallet: f.sellerWallet })
  ).rejects.toThrow('Installed buyer wallet')
  expect(f.counts).toEqual({ preparation: 0, purchase: 0, release: 0 })
}, 60000)

it('preserves the original consent and rejects a changed request or different wallet transaction', async () => {
  const f = await lchNativeCovenantFixture(),
    signal = new AbortController().signal,
    original = f.domain.original()
  original[0] ^= 1
  expect(f.domain.original()).not.toEqual(original)
  await expect(
    f.domain.preflight({ ...f.prepare, requestId: 'ab'.repeat(32) }, f.prepared, signal)
  ).rejects.toThrow('Original LCH request')
  await expect(
    f.domain.verify(
      f.prepare,
      f.prepared,
      { ...f.submission, acquisitionId: 'ab'.repeat(32) },
      f.delivered,
      signal
    )
  ).rejects.toThrow('Original wallet transaction')
  await expect(
    f.domain.verify(f.prepare, f.prepared, { ...f.submission, beef: 'AA==' }, f.delivered, signal)
  ).rejects.toThrow()
  await expect(f.domain.playback(f.delivered, signal)).rejects.toThrow('not been locally verified')
  expect(f.counts.purchase).toBe(0)
}, 60000)

it('rechecks current local access, cancellation and installed proof identity on retained playback', async () => {
  const f = await lchNativeCovenantFixture(),
    signal = new AbortController().signal
  await f.domain.verify(f.prepare, f.prepared, f.submission, f.delivered, signal)
  f.setAccess(false)
  await expect(f.domain.playback(f.delivered, signal)).rejects.toThrow('inaccessible')
  f.setAccess(true)
  const aborted = new AbortController()
  aborted.abort()
  await expect(f.domain.playback(f.delivered, aborted.signal)).rejects.toThrow('cancelled')
  f.options.verification.purchase = () => {
    throw new Error('Changed verifier must never run')
  }
  await expect(f.domain.playback(f.delivered, signal)).rejects.toThrow('changed')
}, 60000)

it('accepts equivalent signed reissue but authenticates every encrypted grant again', async () => {
  const f = await lchNativeCovenantFixture(),
    signal = new AbortController().signal
  await f.domain.verify(f.prepare, f.prepared, f.submission, f.delivered, signal)
  const delivery = new WalletBRC78KeyDelivery(f.sellerWallet),
    keyGrants: KeyGrant[] = []
  for (const [hex, cek] of f.asset.keys) {
    const keyId = Uint8Array.from(Buffer.from(hex, 'hex'))
    keyGrants.push({
      keyId,
      delivery: 'https://bsv.brc.dev/apps/0170#brc78-key-v1',
      payload: await delivery.deliver(f.prepare.recipient, keyId, cek)
    })
  }
  f.setNow('200')
  const license = await signObject(
      'license',
      { ...f.license.body, issuedAt: 200, keyGrants: keyGrants as never },
      f.seller
    ),
    equivalent = await f.deliver(license)
  expect(await f.domain.playback(equivalent, signal)).toEqual(f.plaintext)
  await expect(
    f.domain.playback(await f.deliver({ ...license, signatures: [Uint8Array.of(1)] }), signal)
  ).rejects.toThrow()
  const corrupted = keyGrants.map(grant => ({ ...grant, payload: grant.payload.slice() }))
  corrupted[0].payload[corrupted[0].payload.length - 1] ^= 1
  const damaged = await signObject(
    'license',
    { ...license.body, keyGrants: corrupted as never },
    f.seller
  )
  await expect(f.domain.playback(await f.deliver(damaged), signal)).rejects.toThrow(
    'recovery failed'
  )
  expect(f.counts).toEqual({ preparation: 0, purchase: 1, release: 1 })
}, 60000)

it('opens only the retained domain and immutable original bytes', async () => {
  const f = await lchNativeCovenantFixture(),
    retained = { id: f.domain.id, original: f.domain.original() }
  await expect(
    LCHOverlayCovenantDomain.open(
      f.options,
      { ...retained, id: retained.id + 'changed' },
      f.objects
    )
  ).rejects.toThrow('installation differs')
  const original = retained.original.slice()
  original[0] ^= 1
  await expect(
    LCHOverlayCovenantDomain.open(f.options, { ...retained, original }, f.objects)
  ).rejects.toThrow()
  await expect(
    LCHOverlayCovenantDomain.create({ ...f.options, maximumCiphertextBytes: 0 })
  ).rejects.toThrow('Finite content')
}, 60000)

it('requires a complete synchronous owned guard after actual independent purchase verification', async () => {
  const f = await lchNativeCovenantFixture(),
    signal = new AbortController().signal,
    invalid = [
      () => Object.create({ checkCurrent: () => {} }),
      () => ({
        checkCurrent: async () => {
          await Promise.resolve()
        }
      }),
      () => ({ checkCurrent: () => Promise.resolve() }),
      () => ({ checkCurrent: () => Promise.reject(new Error('Rejected asynchronous guard')) }),
      () => ({ checkCurrent: () => true }),
      () => {
        const result = {
          checkCurrent: () => {
            result.checkCurrent = () => {}
          }
        }
        return result
      }
    ]
  for (const guard of invalid) {
    const domain = await LCHOverlayCovenantDomain.create({
      ...f.options,
      verification: {
        ...f.options.verification,
        purchase: async (...args) => {
          const actual = await f.options.verification.purchase(...args)
          actual.checkCurrent()
          return Object.assign(guard(), { purchaseCommitment: actual.purchaseCommitment })
        }
      }
    })
    await domain.initializeCustody(f.objects)
    await expect(
      domain.verify(f.prepare, f.prepared, f.submission, f.delivered, signal)
    ).rejects.toThrow('guard')
    await expect(domain.playback(f.delivered, signal)).rejects.toThrow('not been locally verified')
  }
  expect(f.counts).toEqual({ preparation: 0, purchase: invalid.length, release: 0 })
}, 60000)

it('checks ciphertext response bounds and cancellation after the actual source resolves', async () => {
  const f = await lchNativeCovenantFixture({ detached: true }),
    signal = new AbortController().signal
  await f.domain.verify(f.prepare, f.prepared, f.submission, f.delivered, signal)
  const original = { id: f.domain.id, original: f.domain.original() }
  for (const read of [
    async () => new Uint8Array(f.options.maximumCiphertextBytes + 1),
    async (...args: Parameters<typeof f.options.source.read>) => {
      const bytes = await f.options.source.read(...args)
      f.setAccess(false)
      return bytes
    }
  ]) {
    f.setAccess(true)
    let fail = false
    const domain = await LCHOverlayCovenantDomain.open(
      {
        ...f.options,
        source: {
          ...f.options.source,
          read: async (...args) => (fail ? read(...args) : f.options.source.read(...args))
        }
      },
      original,
      f.objects
    )
    fail = true
    await expect(domain.playback(f.delivered, signal)).rejects.toThrow()
  }
  f.setAccess(true)
  expect(await f.domain.playback(f.delivered, signal)).toEqual(f.plaintext)
}, 60000)

it('reopens original native buyer custody after Offer expiry without another purchase or online proof', async () => {
  const f = await lchNativeCovenantFixture(),
    signal = new AbortController().signal,
    retained = { id: f.domain.id, original: f.domain.original() }
  await f.domain.verify(f.prepare, f.prepared, f.submission, f.delivered, signal)
  await f.objects.close()
  f.setNow('200')
  const reopened = await LCHOverlayCovenantDomain.open(f.options, retained, f.reopen())
  await expect(reopened.preflight(f.prepare, null, signal)).rejects.toThrow('window')
  expect(await reopened.playback(f.delivered, signal)).toEqual(f.plaintext)
  expect(f.counts.purchase).toBe(1)
  const license = await signObject(
    'license',
    { ...f.license.body, subject: f.seller.identityKey },
    f.seller
  )
  await expect(reopened.playback(await f.deliver(license), signal)).rejects.toThrow(
    'not been locally verified'
  )
}, 60000)

it('pins the independently retained historical revocation source before new work', async () => {
  const revocations = {
      id: 'retained-test-role-assessments',
      at: (time: string) => ({
        status: () =>
          Promise.resolve({
            status: 'unspent' as const,
            network: 'testnet' as const,
            observedAt: BigInt(time)
          })
      })
    },
    f = await lchNativeCovenantFixture({ revocations }),
    signal = new AbortController().signal
  await f.domain.preflight(f.prepare, f.prepared, signal)
  revocations.id = 'changed'
  await expect(f.domain.preflight(f.prepare, f.prepared, signal)).rejects.toThrow('changed')
  expect(f.counts.purchase).toBe(0)
}, 60000)

it('refuses a verifier commitment that differs from the signed historical settlement before recording rights', async () => {
  const f = await lchNativeCovenantFixture(),
    signal = new AbortController().signal,
    domain = await LCHOverlayCovenantDomain.create({
      ...f.options,
      verification: {
        ...f.options.verification,
        purchase: async (...args) => {
          const actual = await f.options.verification.purchase(...args)
          actual.checkCurrent()
          return { purchaseCommitment: '00'.repeat(32), checkCurrent: () => actual.checkCurrent() }
        }
      }
    })
  await domain.initializeCustody(f.objects)
  await expect(
    domain.verify(f.prepare, f.prepared, f.submission, f.delivered, signal)
  ).rejects.toThrow('independently verified purchase commitment')
  await expect(domain.playback(f.delivered, signal)).rejects.toThrow('not been locally verified')
  expect(f.counts.release).toBe(0)
}, 60000)

it('retains historical offline entitlement when independently assessed alias transport evidence is added or replaced', async () => {
  const f = await lchNativeCovenantFixture(),
    signal = new AbortController().signal
  await f.domain.verify(f.prepare, f.prepared, f.submission, f.delivered, signal)
  const original = canonicalOutputJSON(f.delivered),
    digest = await lchOverlayCovenantEntitlementDigest(f.delivered)
  for (const currentAlias of [
    { txid: f.submission.txid, beef: f.submission.beef },
    // Unverified transport bytes neither grant rights nor assert currentness.
    { txid: '55'.repeat(32), beef: 'AA==' }
  ]) {
    const current = { ...f.delivered, currentAlias }
    expect(await lchOverlayCovenantEntitlementDigest(current)).toBe(digest)
    expect(await f.domain.playback(current, signal)).toEqual(f.plaintext)
    expect(canonicalOutputJSON(f.delivered)).toBe(original)
  }
  expect(f.counts.purchase).toBe(1)
}, 60000)
