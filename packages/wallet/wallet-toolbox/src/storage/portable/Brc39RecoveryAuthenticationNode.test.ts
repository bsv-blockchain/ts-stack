import { nativeTestExecutable } from './Brc38NativeTestPath'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Brc39RecoveryAuthenticationNode } from './Brc39RecoveryAuthenticationNode'
import { Brc38StagingAdmissionNode } from './Brc38StagingAdmissionNode'
import { Brc38NativeRecoveryTemporaryQuota } from './Brc38NativeRecoveryScratchNode'
import {
  authenticatedStageOptions,
  authenticatedStagePassword,
  encrypted
} from './Brc38AuthenticatedPrivateStageFixture'
import { brc38StagingBinding } from './Brc38StagingBinding'
import { semanticStageFixture } from './Brc38SemanticStageFixture'

// UNRUN genuine crypto/private-native source cases. They do not qualify an
// expired pending target, reconstructed local semantics or manager activation.
describe('new BRC39 recovery authentication purpose', () => {
  let directory: string, admission: Brc38StagingAdmissionNode
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'brc39-recovery-auth-'))
    admission = await Brc38StagingAdmissionNode.create(directory, {
      maximumImports: 1,
      maximumPhysicalBytes: 7340032,
      maximumLogicalBytes: 1048576
    })
  })
  afterEach(async () => {
    await admission.close()
    await rm(directory, { recursive: true, force: true })
  })
  async function input() {
    const bytes = await encrypted(),
      original = {
        ...authenticatedStageOptions(bytes),
        reservationId: randomUUID(),
        streamedFields: { maximumBinaryBytes: 262144, maximumChunkBytes: 1024 },
        streamedTextFields: { maximumTextBytes: 262144, maximumChunkBytes: 1024 },
        streamedStructuredFields: {
          fields: { maximumStructuredBytes: 1000000, maximumChunkBytes: 1024 },
          staging: {
            privateIndexParent: directory,
            maximumTemporaryIndexBytes: 1048576,
            maximumIndexMembers: 10000,
            maximumStructuredBytes: 1000000,
            maximumCanonicalBytes: 1000000
          }
        }
      }
    original.limits = { ...original.limits, expiresAt: Date.now() - 1000 }
    const options = {
      original,
      admission,
      temporaryQuota: new Brc38NativeRecoveryTemporaryQuota(7340032),
      expiresAt: Date.now() + 60000,
      executable: nativeTestExecutable()
    }
    return { bytes, options }
  }
  async function* chunks(bytes: Uint8Array) {
    for (let offset = 0; offset < bytes.length; offset += 137) yield bytes.slice(offset, offset + 137)
  }
  test('the actual full envelope seals a distinct frozen source while original expiry/binding remain unchanged', async () => {
    const { bytes, options } = await input(),
      original = structuredClone(options.original),
      bound = brc38StagingBinding(original.binding, original.limits)
    let escaped: Brc39RecoveryAuthenticationNode | undefined
    await Brc39RecoveryAuthenticationNode.with(chunks(bytes), authenticatedStagePassword, options, async source => {
      escaped = source
      expect(source.original).toEqual(bound)
      expect(source.reservationId).not.toBe(original.reservationId)
      expect(source.store.limits).toEqual({ ...original.limits, expiresAt: options.expiresAt })
      expect(source.store.binding!.digest).not.toBe(bound.digest)
      expect((await admission.usage()).imports).toBe(1)
      expect(options.temporaryQuota.used).toBe(original.limits.maximumPhysicalBytes)
      await source.withSource(async store => {
        const metadata = await store.knex('metadata').where({ slot: 1 }).first('state', 'header')
        expect(metadata.state).toBe('sealed')
        expect(JSON.parse(metadata.header).user).toEqual(semanticStageFixture().user)
        expect((await store.knex('table_counts').orderBy('tableName').select('rows')).map(row => row.rows)).toEqual(
          Array(13).fill(1)
        )
        await expect(store.knex('metadata').where({ slot: 1 }).update({ header: '{}' })).rejects.toMatchObject({
          code: 'SQLITE_AUTH'
        })
      })
      source.assertRetained()
      expect(() => Brc39RecoveryAuthenticationNode.prototype.assertRetained.call({ ...source })).toThrow()
    })
    expect(options.original).toEqual(original)
    expect(options.temporaryQuota.used).toBe(0)
    expect((await admission.usage()).imports).toBe(0)
    expect(await readdir(directory)).toEqual(['brc38-admission.sqlite'])
    expect(() => escaped!.assertRetained()).toThrow('unavailable')
  })
  test('new-purpose cancellation prevents source exposure and releases its own reservation only', async () => {
    const { bytes, options } = await input(),
      cancellation = new AbortController(),
      original = structuredClone(options.original)
    cancellation.abort(new Error('new recovery purpose cancelled'))
    let entered = false
    await expect(
      Brc39RecoveryAuthenticationNode.with(
        chunks(bytes),
        authenticatedStagePassword,
        { ...options, signal: cancellation.signal },
        async () => {
          entered = true
        }
      )
    ).rejects.toThrow('new recovery purpose cancelled')
    expect(entered).toBe(false)
    expect(options.original).toEqual(original)
    expect(options.temporaryQuota.used).toBe(0)
    expect((await admission.usage()).imports).toBe(0)
    expect(await readdir(directory)).toEqual(['brc38-admission.sqlite'])
  })
  test.each(['password', 'truncated', 'tag'] as const)(
    'rejected %s cannot expose a source or retain a successful charge',
    async variant => {
      const { bytes, options } = await input(),
        original = structuredClone(options.original),
        rejected = bytes.slice()
      if (variant === 'tag') rejected[rejected.length - 1] ^= 1
      let entered = false
      await expect(
        Brc39RecoveryAuthenticationNode.with(
          chunks(variant === 'truncated' ? rejected.slice(0, -1) : rejected),
          variant === 'password' ? 'incorrect recovery password' : authenticatedStagePassword,
          options,
          async () => {
            entered = true
          }
        )
      ).rejects.toThrow()
      expect(entered).toBe(false)
      expect(options.original).toEqual(original)
      expect(options.temporaryQuota.used).toBe(0)
      expect((await admission.usage()).imports).toBe(0)
      expect(await readdir(directory)).toEqual(['brc38-admission.sqlite'])
    }
  )
})
