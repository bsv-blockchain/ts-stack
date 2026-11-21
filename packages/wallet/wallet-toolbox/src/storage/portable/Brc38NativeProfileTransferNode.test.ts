import { Client, type Knex } from 'knex'
import createKnex from 'knex'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInSeries } from '../../utility/runInSeries'
import { previewPrivateFixture, previewReceiptPolicy } from './Brc38ImportPreviewFixture'
import { restoreProofFixture, restorePortableProof } from '../../../test/utils/Brc38ImportEntityRestoreFixture'
import { Brc38PrivateNativeRestoreNode } from './Brc38PrivateNativeRestoreNode'
import { Brc38PublishedProfileNode, type Brc38NativeProfileTransferClaim } from './Brc38PublishedProfileNode'
import { Brc38ProfileInventoryNode } from './Brc38ProfileInventoryNode'

const capacity = { maximumProfiles: 1, maximumPhysicalBytes: 11534336 }
interface OwnedClient {
  config: { connection: unknown }
  destroy(): Promise<void>
}
const clientPrototype = Client.prototype as unknown as OwnedClient

describe('actual original profile and inventory certificate before native handoff', () => {
  let source: Awaited<ReturnType<typeof completedSource>>
  let cleanup: Array<() => Promise<void>>
  async function completedSource() {
    const proof = restoreProofFixture()
    const staged = await previewPrivateFixture(undefined, data => restorePortableProof(data, proof), 2097152, 8388608)
    const restore = await Brc38PrivateNativeRestoreNode.open(staged.value.reservation.store, {
      receiptPolicy: previewReceiptPolicy,
      maximumStepRows: 16,
      maximumStepBytes: 2097152,
      maximumMappedIds: 1000,
      maximumJournalLogicalBytes: 516096,
      services: proof.services
    })
    await runInSeries(
      Array.from({ length: 14 }, (_v, index) => index),
      async fromRow => {
        expect(await restore.step(fromRow)).toMatchObject({ nextRow: fromRow + 1 })
      }
    )
    return {
      proof,
      staged,
      restore,
      store: staged.value.reservation.store,
      admission: restore.admission
    }
  }
  beforeAll(async () => {
    source = await completedSource()
  })
  afterAll(async () => {
    await source.restore.close()
    await source.staged.close()
  })
  beforeEach(() => {
    cleanup = []
  })
  afterEach(async () => {
    const results = await Promise.allSettled(cleanup.map(close => close()))
    const errors = results.flatMap(r => (r.status === 'rejected' ? [r.reason] : []))
    if (errors.length) throw new AggregateError(errors, 'Native transfer retains fixture cleanup')
  })
  async function fixture() {
    // Publication deliberately closes its source facade. Each ordinary case
    // releases the previous actual kernel and explicitly resumes the same
    // durable COMPLETE source, original binding and unrenewed deadline.
    await source.restore.close()
    await source.store.close()
    const reservation = await source.staged.root.resume(
      source.staged.value.reservation.id,
      source.staged.selected.limits,
      source.staged.selected.binding
    )
    source.staged.held.push(reservation)
    source.store = reservation.store
    const directory = await mkdtemp(join(tmpdir(), 'brc38-native-transfer-'))
    const root = await Brc38ProfileInventoryNode.create(directory, capacity)
    const roots = [root],
      profiles: Brc38PublishedProfileNode[] = []
    cleanup.push(async () => {
      await runInSeries(profiles, async profile => await profile.close())
      await runInSeries(roots, async item => await item.close())
      await rm(directory, { recursive: true, force: true })
    })
    const profile = await root.publish(source.store, source.admission)
    async function peer() {
      const other = await Brc38ProfileInventoryNode.reopen(directory, capacity)
      roots.push(other)
      return other
    }
    return { root, directory, profile, peer, profiles }
  }
  async function database(directory: string, file: string): Promise<Knex> {
    const k = createKnex({
      client: 'better-sqlite3',
      connection: { filename: join(directory, file) },
      useNullAsDefault: true,
      pool: { min: 1, max: 1 }
    })
    cleanup.push(async () => await k.destroy())
    return k
  }
  async function opaque(profile: Brc38PublishedProfileNode, root: Brc38ProfileInventoryNode) {
    const claim = await profile.prepareNativeClaim(root)
    expect(Object.isFrozen(claim)).toBe(true)
    expect(Object.getPrototypeOf(claim)).toBeNull()
    expect(Reflect.ownKeys(claim)).toEqual([])
    return claim
  }
  test('ordinary runtime constructors cannot mint enrolled profile or inventory issuers', () => {
    expect(() => Reflect.construct(Brc38PublishedProfileNode, ['', {}, {}, {}, {}])).toThrow(
      'actual published profile issuer'
    )
    expect(() => Reflect.construct(Brc38ProfileInventoryNode, [{}, '', capacity, '', {}, {}])).toThrow(
      'actual profile inventory issuer'
    )
  })
  test('actual certificate is opaque, copies grant nothing and private database observations are absent', async () => {
    const { root, profile } = await fixture(),
      claim = await opaque(profile, root)
    expect(Object.hasOwn(root, 'db')).toBe(false)
    for (const field of ['db', 'ownerDb', 'connection', 'fixed']) expect(Object.hasOwn(profile, field)).toBe(false)
    expect(Object.getOwnPropertyDescriptor(profile, 'directory')).toMatchObject({
      writable: false,
      configurable: false
    })
    await expect(Brc38PublishedProfileNode.releaseNativeClaim({ ...claim })).rejects.toThrow('actual pending')
    Brc38PublishedProfileNode.cancelNativeClaim(claim)
    await expect(Brc38PublishedProfileNode.releaseNativeClaim(claim)).rejects.toThrow('actual pending')
    expect(await profile.status()).toMatchObject({ state: 'READY' })
  })
  test('copied receivers and caller inventory flags cannot issue an actual transfer certificate', async () => {
    const { root, profile } = await fixture()
    await expect(Brc38PublishedProfileNode.prototype.prepareNativeClaim.call({ ...profile }, root)).rejects.toThrow(
      'actual published profile issuer'
    )
    await expect(profile.prepareNativeClaim({ ...root } as unknown as Brc38ProfileInventoryNode)).rejects.toThrow(
      'actual profile inventory issuer'
    )
    expect(await profile.status()).toMatchObject({ state: 'READY' })
  })
  test('a distinct real root handle with copied durable identity cannot claim another handle ownership', async () => {
    const { root, profile, peer } = await fixture(),
      other = await peer()
    await expect(profile.prepareNativeClaim(other)).rejects.toThrow('actual current published inventory operation')
    const claim = await opaque(profile, root)
    Brc38PublishedProfileNode.cancelNativeClaim(claim)
  })
  test('direct issuer entry without the real per-profile inventory operation is refused', async () => {
    const { root, profile } = await fixture()
    await expect(Brc38PublishedProfileNode.issueNativeClaim(profile, root)).rejects.toThrow(
      'actual current published inventory operation'
    )
    expect(await root.usage()).toMatchObject({ profiles: 1, published: 1 })
  })
  test('offered claim reserves activation, cancellation restores stock behavior and exposed manager forbids handoff', async () => {
    const { root, profile } = await fixture(),
      claim = await opaque(profile, root)
    await expect(profile.activate(source.proof.services)).rejects.toThrow('reserved for native handoff')
    Brc38PublishedProfileNode.cancelNativeClaim(claim)
    expect((await profile.activate(source.proof.services)).isActiveEnabled).toBe(true)
    await expect(profile.prepareNativeClaim(root)).rejects.toThrow('exposed wallet')
  })
  test('actual stock owner is held before release and physically reacquirable only after awaited transfer', async () => {
    const { root, profile, profiles } = await fixture(),
      claim = await opaque(profile, root)
    await expect(Brc38PublishedProfileNode.open(profile.directory, source.store.binding!.digest)).rejects.toThrow()
    const receipt = await Brc38PublishedProfileNode.releaseNativeClaim(claim)
    expect(Object.isFrozen(receipt)).toBe(true)
    expect(receipt).toMatchObject({
      directory: profile.directory,
      state: 'READY',
      bindingSha256: source.store.binding!.digest
    })
    expect(profile.ownershipReleased).toBe(true)
    await expect(profile.status()).rejects.toThrow('closed')
    await expect(Brc38PublishedProfileNode.releaseNativeClaim(claim)).rejects.toThrow('actual pending')
    const recovered = await Brc38PublishedProfileNode.open(profile.directory, receipt.bindingSha256)
    profiles.push(recovered)
    expect(await recovered.status()).toMatchObject({ state: 'READY' })
    expect(await root.usage()).toEqual({
      profiles: 1,
      published: 1,
      reservedPhysicalBytes: 11534336
    })
  })
  test('fresh durable retiring state refuses handoff despite the previous cached publication acknowledgement', async () => {
    const { root, profile, directory } = await fixture(),
      claim = await opaque(profile, root)
    const k = await database(directory, 'profile-inventory.sqlite')
    await k('profile_inventory').update({ state: 'retiring' })
    await k.destroy()
    await expect(Brc38PublishedProfileNode.releaseNativeClaim(claim)).rejects.toThrow(
      'actual current published inventory operation'
    )
    expect(profile.ownershipReleased).toBe(false)
    expect(await profile.status()).toMatchObject({ state: 'READY' })
    Brc38PublishedProfileNode.cancelNativeClaim(claim)
  })
  test('ordinary failed owner destruction retains cleanup ownership and the same certificate retries real drain', async () => {
    const { root, profile } = await fixture(),
      claim = await opaque(profile, root),
      original = clientPrototype.destroy
    let refused = false
    const destroy = jest.spyOn(clientPrototype, 'destroy').mockImplementation(async function (this: OwnedClient) {
      const c = this.config.connection
      if (
        !refused &&
        typeof c === 'object' &&
        c !== null &&
        'filename' in c &&
        c.filename === join(profile.directory, 'owner.sqlite')
      ) {
        refused = true
        throw new Error('ordinary retained owner cleanup')
      }
      await original.call(this)
    })
    try {
      await expect(Brc38PublishedProfileNode.releaseNativeClaim(claim)).rejects.toThrow(
        'ordinary retained owner cleanup'
      )
    } finally {
      destroy.mockRestore()
    }
    expect(refused).toBe(true)
    expect(profile.ownershipReleased).toBe(false)
    await expect(Brc38PublishedProfileNode.open(profile.directory, source.store.binding!.digest)).rejects.toThrow()
    expect(() => Brc38PublishedProfileNode.cancelNativeClaim(claim)).toThrow('idle offered')
    expect(await Brc38PublishedProfileNode.releaseNativeClaim(claim)).toMatchObject({
      state: 'READY'
    })
    expect(profile.ownershipReleased).toBe(true)
  })
  test('actual asynchronous owner destruction blocks root close and retains capacity until completion', async () => {
    const { root, profile } = await fixture(),
      claim = await opaque(profile, root),
      original = clientPrototype.destroy
    let resume!: () => void, observed!: () => void
    const hold = new Promise<void>(resolve => {
        resume = resolve
      }),
      reached = new Promise<void>(resolve => {
        observed = resolve
      })
    let intercepted = false
    const destroy = jest.spyOn(clientPrototype, 'destroy').mockImplementation(async function (this: OwnedClient) {
      const c = this.config.connection
      if (
        !intercepted &&
        typeof c === 'object' &&
        c !== null &&
        'filename' in c &&
        c.filename === join(profile.directory, 'owner.sqlite')
      ) {
        intercepted = true
        observed()
        await hold
      }
      await original.call(this)
    })
    const pending = Brc38PublishedProfileNode.releaseNativeClaim(claim)
    try {
      await reached
      expect(profile.ownershipReleased).toBe(false)
      await expect(root.close()).rejects.toThrow('actual profile inventory work')
      expect(await root.usage()).toEqual({
        profiles: 1,
        published: 1,
        reservedPhysicalBytes: 11534336
      })
      await expect(Brc38PublishedProfileNode.open(profile.directory, source.store.binding!.digest)).rejects.toThrow()
    } finally {
      resume()
      await pending
      destroy.mockRestore()
    }
    expect(profile.ownershipReleased).toBe(true)
  })
  test('completed managed publication transfers after original import expiry without renewing receipt policy', async () => {
    const { root, profile } = await fixture()
    const now = jest.spyOn(Date, 'now').mockReturnValue(source.admission.expiresAt + 1)
    try {
      const receipt = await Brc38PublishedProfileNode.releaseNativeClaim(await opaque(profile, root))
      expect(JSON.parse(receipt.fixedJson)).toMatchObject({
        admission: { expiresAt: source.admission.expiresAt },
        limits: { expiresAt: source.admission.expiresAt }
      })
    } finally {
      now.mockRestore()
    }
  })
  test('parallel preparation cannot issue two certificates for one actual profile operation', async () => {
    const { root, profile } = await fixture()
    const first = profile.prepareNativeClaim(root),
      second = profile.prepareNativeClaim(root)
    const results = await Promise.allSettled([first, second])
    expect(results[0]!.status).toBe('fulfilled')
    expect(results[1]!.status).toBe('rejected')
    if (results[0]!.status === 'fulfilled') Brc38PublishedProfileNode.cancelNativeClaim(results[0]!.value)
  })
  test('closing actual offered profile invalidates its certificate while durable inventory capacity remains', async () => {
    const { root, profile } = await fixture(),
      claim = await opaque(profile, root)
    await profile.close()
    await expect(Brc38PublishedProfileNode.releaseNativeClaim(claim)).rejects.toThrow('actual pending')
    expect(await root.usage()).toEqual({
      profiles: 1,
      published: 1,
      reservedPhysicalBytes: 11534336
    })
  })
  test('fresh durable ACTIVE reopen can transfer without exposing the old manager', async () => {
    const { root, profile } = await fixture()
    await profile.activate(source.proof.services)
    await profile.close()
    const fresh = await root.open(source.admission.scope.importId, source.store.binding!.digest)
    expect(fresh).not.toBe(profile)
    const receipt = await Brc38PublishedProfileNode.releaseNativeClaim(await opaque(fresh, root))
    expect(receipt.state).toBe('ACTIVE')
    expect(fresh.ownershipReleased).toBe(true)
  })
  test('original durable ACTIVATING state and empty permitted primary transfer without an invented ACTIVE marker', async () => {
    const { root, profile } = await fixture()
    const k = await database(profile.directory, 'profile.sqlite')
    await k('profile').where({ slot: 1 }).update({ state: 'ACTIVATING' })
    await k.destroy()
    const receipt = await Brc38PublishedProfileNode.releaseNativeClaim(await opaque(profile, root))
    expect(receipt.state).toBe('ACTIVATING')
    expect(profile.ownershipReleased).toBe(true)
  })
  test('original READY copy verification is repeated before physical owner release', async () => {
    const { root, profile } = await fixture(),
      claim: Brc38NativeProfileTransferClaim = await opaque(profile, root)
    const k = await database(profile.directory, 'wallet.sqlite')
    await k('users').update({ identityKey: 'ordinary changed owned fixture identity' })
    await k.destroy()
    await expect(Brc38PublishedProfileNode.releaseNativeClaim(claim)).rejects.toThrow('copy digest differs')
    expect(profile.ownershipReleased).toBe(false)
    Brc38PublishedProfileNode.cancelNativeClaim(claim)
  })
})
