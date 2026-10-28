import fc from 'fast-check'
import { createHash } from 'node:crypto'
import createKnex, { type Knex } from 'knex'
import {
  fixedProfile,
  pages,
  readForwardOriginalProfileRow,
  readOriginalProfileRow,
  readRow,
  validPrimary,
  type FixedProfile,
  type Row,
  type State
} from './Brc38PublishedProfileReceiptNode'
import type { KnexBrc38StagingLimits } from './Brc38StagingBinding'

const MIN_PROPERTY_RUNS = 300
fc.configureGlobal({
  numRuns: Math.max(
    MIN_PROPERTY_RUNS,
    Number(process.env.FAST_CHECK_NUM_RUNS ?? process.env.FC_NUM_RUNS ?? MIN_PROPERTY_RUNS)
  ),
  seed: Number(process.env.FAST_CHECK_SEED ?? process.env.FC_SEED ?? 3242026)
})
const controls = {
  interruptAfterTimeLimit: 150000,
  markInterruptAsFailure: true,
  path: process.env.FAST_CHECK_PATH ?? process.env.FC_PATH ?? ''
}
const text = fc.array(fc.constantFrom('x', 'é', '中', '😀'), { minLength: 1, maxLength: 24 }).map(v => v.join(''))
const states: State[] = ['RECEIVING', 'READY', 'ACTIVATING', 'ACTIVE']
const tables = ['profile', 'profile_original'] as const
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
let db: Knex
beforeEach(async () => {
  db = createKnex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
    pool: { min: 1, max: 1 }
  })
  await chooseTable('profile')
})
afterEach(async () => {
  await db.destroy()
})
const receiving = (value: string): Row => {
  const fixedJson = JSON.stringify({ originalReceipt: value })
  return {
    state: 'RECEIVING',
    fixedJson,
    fixedSha256: hash(fixedJson),
    copySha256: null,
    copyBytes: null
  }
}
async function chooseTable(name: (typeof tables)[number]) {
  // Original readRow accepts the single stock profile layout. Forward transport
  // is tested directly against its own stock row; it is not native migration.
  const other = name === 'profile' ? 'profile_original' : 'profile'
  await db.schema.dropTableIfExists(other)
  if (!(await db.schema.hasTable(name))) {
    await db.schema.createTable(name, table => {
      table.integer('slot').primary()
      table.text('state').notNullable()
      table.text('fixedJson').notNullable()
      table.text('fixedSha256').notNullable()
      table.text('copySha256').nullable()
      table.bigInteger('copyBytes').nullable()
    })
  }
}
async function replace(name: (typeof tables)[number], row: Row) {
  await chooseTable(name)
  await db(name).delete()
  await db(name).insert({ slot: 1, ...row })
}
const reader = (name: (typeof tables)[number]) =>
  name === 'profile' ? readOriginalProfileRow(db) : readForwardOriginalProfileRow(db)

// Ordinary valid source-owned SQLite catalog transport and pure policy parsing.
// These synthetic receipts grant no native process, wallet, inventory, physical
// allocation, publication or activation authority.
test('generated original and forwarded receiving rows preserve complete Unicode metadata and absent copy fields', async () => {
  await fc.assert(
    fc.asyncProperty(text, fc.constantFrom(...tables), async (value, name) => {
      const row = receiving(value)
      await replace(name, row)
      expect(await reader(name)).toEqual(row)
      if (name === 'profile') expect(await readRow(db)).toEqual(row)
      expect(await db(name)).toEqual([{ slot: 1, ...row }])
    }),
    controls
  )
}, 30000)
test('generated complete receipt states preserve their independently computed digest and exact copy extent', async () => {
  await fc.assert(
    fc.asyncProperty(
      text,
      fc.constantFrom<State>('READY', 'ACTIVATING', 'ACTIVE'),
      fc.integer({ min: 4096, max: 1048576 }),
      fc.constantFrom(...tables),
      async (value, state, bytes, name) => {
        const row: Row = {
          ...receiving(value),
          state,
          copySha256: hash('copied bytes ' + value),
          copyBytes: bytes
        }
        await replace(name, row)
        expect(await reader(name)).toEqual(row)
        expect(await db(name)).toEqual([{ slot: 1, ...row }])
      }
    ),
    controls
  )
}, 30000)
test('generated same-size metadata changes, unknown states and above-limit byte metadata refuse without changing durable rows', async () => {
  await fc.assert(
    fc.asyncProperty(text, fc.integer({ min: 0, max: 3 }), fc.constantFrom(...tables), async (value, kind, name) => {
      const base = receiving(value)
      const row =
        kind === 0
          ? { ...base, fixedSha256: hash(base.fixedJson + '!') }
          : kind === 1
            ? { ...base, state: 'STALLED' }
            : kind === 2
              ? { ...base, fixedJson: 'x'.repeat(8193) }
              : { ...base, fixedSha256: 'a'.repeat(65) }
      await chooseTable(name)
      await db(name).delete()
      await expect(reader(name)).rejects.toThrow('catalog differs')
      await db(name).insert({ slot: 1, ...row })
      const before = await db(name)
      await expect(reader(name)).rejects.toThrow('catalog differs')
      expect(await db(name)).toEqual(before)
    }),
    controls
  )
}, 30000)
test('generated complete states refuse absent, noncanonical or out-of-range copy receipts while retaining the original catalog', async () => {
  await fc.assert(
    fc.asyncProperty(
      text,
      fc.constantFrom<State>('READY', 'ACTIVATING', 'ACTIVE'),
      fc.integer({ min: 0, max: 5 }),
      async (value, state, kind) => {
        const row: Row = { ...receiving(value), state, copySha256: hash(value), copyBytes: 4096 }
        if (kind === 0) row.copySha256 = null
        else if (kind === 1) row.copySha256 = 'a'.repeat(63)
        else if (kind === 2) row.copySha256 = 'A' + 'a'.repeat(63)
        else if (kind === 3) row.copyBytes = null
        else if (kind === 4) row.copyBytes = 4095
        else row.copyBytes = 4096.5
        await replace('profile', row)
        const before = await db('profile')
        await expect(readRow(db)).rejects.toThrow('copy receipt differs')
        expect(await db('profile')).toEqual(before)
      }
    ),
    controls
  )
}, 30000)
test('generated page budgets and every primary-state rule match the independent fixed-overhead model', () => {
  fc.assert(
    fc.property(
      text,
      fc.integer({ min: 1048576, max: 1000000000 }),
      fc.constantFrom(...states),
      fc.integer({ min: 0, max: 2 }),
      (selected, maximumPhysicalBytes, state, mode) => {
        const limits: KnexBrc38StagingLimits = {
          maximumRows: 1,
          maximumLogicalBytes: 1,
          maximumPhysicalBytes,
          maximumRowBytes: 1,
          maximumRowAllocationBytes: 1,
          expiresAt: 1
        }
        expect(pages(limits)).toBe(Math.floor((maximumPhysicalBytes - 131072) / 12288))
        expect(pages({ ...limits, maximumPhysicalBytes: Number.MAX_SAFE_INTEGER })).toBe(2147483646)
        const primary = mode === 0 ? '' : mode === 1 ? selected : selected + '!'
        const expected =
          state === 'READY'
            ? primary === ''
            : state === 'ACTIVE'
              ? primary === selected
              : primary === '' || primary === selected
        expect(validPrimary(state, primary, selected)).toBe(expected)
      }
    ),
    controls
  )
}, 30000)
function fixed(value: string, generation: number): { profile: FixedProfile; digest: string } {
  const limits: KnexBrc38StagingLimits = {
    maximumRows: 1000,
    maximumLogicalBytes: 1048576,
    maximumPhysicalBytes: 4194304,
    maximumRowBytes: 65536,
    maximumRowAllocationBytes: 65536,
    expiresAt: 1000000000000
  }
  const binding = {
    archiveSha256: hash(value),
    identityKey: value,
    chain: 'test' as const,
    sourceStorageIdentityKey: 'source',
    targetStorageIdentityKey: 'target',
    targetGeneration: generation
  }
  const originalLimitsJson = JSON.stringify([
    limits.maximumRows,
    limits.maximumLogicalBytes,
    limits.maximumPhysicalBytes,
    limits.maximumRowBytes,
    limits.maximumRowAllocationBytes,
    limits.expiresAt
  ])
  const digest = hash(JSON.stringify(['brc38-resumable-private/v1', JSON.stringify(binding), originalLimitsJson]))
  return {
    digest,
    profile: {
      protocol: 'brc38-published-profile/v1',
      binding,
      bindingSha256: digest,
      limits,
      admission: {
        scope: {
          importId: '11111111-1111-4111-8111-111111111111',
          bindingSha256: digest,
          archiveSha256: binding.archiveSha256,
          userId: 7
        },
        previewId: '22222222-2222-4222-8222-222222222222',
        originalLimitsJson,
        expiresAt: limits.expiresAt,
        initialDestinationSha256: hash('original destination'),
        totalRows: 1,
        maximumStepRows: 1,
        maximumStepBytes: 65536,
        maximumMappedIds: 1,
        maximumJournalLogicalBytes: 4608
      }
    }
  }
}
test('generated original fixed policies retain independently bound identities and refuse changed digests, admission or expiry', () => {
  fc.assert(
    fc.property(
      text,
      fc.integer({ min: 0, max: 1000000 }),
      fc.integer({ min: 0, max: 3 }),
      (value, generation, kind) => {
        const { profile, digest } = fixed(value, generation)
        const original = { ...receiving(value), fixedJson: JSON.stringify(profile) }
        expect(fixedProfile(original, digest)).toEqual(profile)
        const changed = structuredClone(profile)
        if (kind === 0) changed.bindingSha256 = hash(digest)
        else if (kind === 1)
          changed.admission = {
            ...changed.admission,
            scope: { ...changed.admission.scope, bindingSha256: hash(digest) }
          }
        else if (kind === 2) changed.admission = { ...changed.admission, expiresAt: changed.admission.expiresAt + 1 }
        else changed.admission = { ...changed.admission, originalLimitsJson: '[]' }
        expect(() => fixedProfile({ ...original, fixedJson: JSON.stringify(changed) }, digest)).toThrow(
          'original binding or policy differs'
        )
        expect(fixedProfile(original, digest)).toEqual(profile)
      }
    ),
    controls
  )
}, 30000)
test('generated v2 completed receipts refuse absent physical bindings while the explicit receiving parser retains its limited role', () => {
  fc.assert(
    fc.property(
      text,
      fc.integer({ min: 0, max: 1000000 }),
      fc.constantFrom<State>('READY', 'ACTIVATING', 'ACTIVE'),
      (value, generation, state) => {
        const { profile, digest } = fixed(value, generation)
        profile.protocol = 'brc38-published-profile/v2'
        const original = { ...receiving(value), fixedJson: JSON.stringify(profile) }
        expect(fixedProfile(original, digest)).toEqual(profile)
        expect(() => fixedProfile({ ...original, state }, digest)).toThrow('physical binding is incomplete')
      }
    ),
    controls
  )
}, 30000)
