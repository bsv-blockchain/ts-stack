import { Brc38WorkingAllocation } from './Brc38WorkingAllocation'
import { chmod, lstat, mkdtemp, open, readdir, realpath, rm, symlink, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { Brc38NodeJsonIndex, type Brc38NodeJsonIndexPolicy } from './Brc38NodeJsonIndex'
import { canonicalBrc38StructuredJson, type Brc38JsonMember } from './Brc38StructuredJson'
import { projectBrc38PackedRow } from './Brc38PackedRow'
import { canonicalPortableChunks } from './CanonicalPortableChunks'
import { SnapshotResourceLimitError } from '../snapshot/SnapshotResourceLimitError'

// Source-only independent small filesystem oracles. No native driver, SQL
// process, profile admission or production-readiness evidence follows.
const parents: string[] = [],
  owners: Brc38NodeJsonIndex[] = []
async function policy(extra: Partial<Brc38NodeJsonIndexPolicy> = {}): Promise<Brc38NodeJsonIndexPolicy> {
  const directory = await mkdtemp(join(tmpdir(), 'brc38-json-index-case-'))
  parents.push(directory)
  await chmod(directory, 0o700)
  return {
    privateParent: await realpath(directory),
    sourceBytes: 1000000,
    maximumTemporaryFileBytes: 8388608,
    maximumMembers: 100000,
    expiresAt: Date.now() + 300000,
    ...extra
  }
}
async function owner(selected: Brc38NodeJsonIndexPolicy): Promise<Brc38NodeJsonIndex> {
  const result = await Brc38NodeJsonIndex.open(selected)
  owners.push(result)
  return result
}
function member(key: string, offset: number): Brc38JsonMember {
  return { key, keyOffset: offset, start: offset + 1, end: offset + 2 }
}
async function entries(index: Brc38NodeJsonIndex, object: number): Promise<Brc38JsonMember[]> {
  const result: Brc38JsonMember[] = []
  for await (const value of index.entries(object)) result.push(value)
  return result
}
afterEach(async () => {
  const failures: unknown[] = []
  for (const index of owners.splice(0)) {
    try {
      await index.close()
    } catch (error) {
      failures.push(error)
    }
  }
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true })
  if (failures.length > 0) throw new AggregateError(failures, 'Index fixture physical cleanup failed')
})

test('authenticated point lookup preserves sorted successors, last duplicates, object bounds and revocation', async () => {
  const index = await owner(await policy()),
    keys = ['', 'a', 'aa', 'b', '😀', '\ue000'],
    expected = new Map<string, Brc38JsonMember>()
  await expect(index.nextEntry(0)).rejects.toThrow()
  for (let at = 0; at < keys.length; at++) {
    const value = member(keys[at], 20 + at * 3)
    await index.put(0, value)
    expected.set(value.key, value)
  }
  const last = member('a', 80)
  await index.put(0, last)
  expected.set('a', last)
  await index.put(100, member('other object', 200))
  await index.seal()
  for (const after of [undefined, ...keys, 'ab', 'z', '\uffff']) {
    const key = [...expected.keys()].sort().find(key => after === undefined || key > after)
    expect(await index.nextEntry(0, after)).toEqual(key === undefined ? undefined : expected.get(key))
  }
  expect(await index.nextEntry(1)).toBeUndefined()
  expect(await index.nextEntry(100)).toEqual(member('other object', 200))
  await expect(index.nextEntry(0, 'x'.repeat(8193))).rejects.toThrow()
  await index.close()
  await expect(index.nextEntry(0)).rejects.toThrow()
})

test('multiple bounded external merge passes preserve UTF16 order, objects and last original duplicate', async () => {
  const selected = await policy(),
    index = await owner(selected),
    expected = new Map<number, Map<string, Brc38JsonMember>>()
  const long = 'x'.repeat(6000)
  for (let sequence = 0; sequence < 73; sequence++) {
    const object = sequence % 2 === 0 ? 0 : 5000,
      key = `${String(72 - sequence).padStart(3, '0')}${long}`,
      value = member(key, 10000 + sequence * 3)
    await index.put(object, value)
    let map = expected.get(object)
    if (map === undefined) {
      map = new Map()
      expected.set(object, map)
    }
    map.set(key, value)
  }
  for (const key of ['😀', '\ue000', 'a', 'aa', '']) {
    const first = member(key, 20000),
      last = member(key, 21000)
    await index.put(0, first)
    await index.put(0, last)
    expected.get(0)!.set(key, last)
  }
  await index.seal()
  for (const object of [0, 5000]) {
    const map = expected.get(object)!,
      keys = [...map.keys()].sort()
    expect(await entries(index, object)).toEqual(keys.map(key => map.get(key)))
  }
  expect(await entries(index, 4999)).toEqual([])
  await index.close()
  await index.close()
  expect(await readdir(selected.privateParent)).toEqual([])
  await expect(index.put(0, member('late', 1))).rejects.toThrow()
})
test('bounded key lookup retains first insertion position and last value without changing entries shape', async () => {
  const selected = await policy(),
    index = await owner(selected)
  await index.put(0, member('01', 100))
  await index.put(0, member('1e0', 200))
  await index.put(0, member('01', 300))
  await index.put(500, member('01', 700))
  await index.seal()
  expect(await index.lookup(0, '01')).toEqual({ ...member('01', 300), firstKeyOffset: 100 })
  expect(await index.lookup(0, '1e0')).toEqual({ ...member('1e0', 200), firstKeyOffset: 200 })
  expect(await index.lookup(500, '01')).toEqual({ ...member('01', 700), firstKeyOffset: 700 })
  expect(await index.lookup(0, 'missing')).toBeUndefined()
  expect(await entries(index, 0)).toEqual([member('01', 300), member('1e0', 200)])
  await index.close()
  await expect(index.lookup(0, '01')).rejects.toThrow()
})

test('same-sized key ordinal tampering cannot supply a previous insertion position', async () => {
  const selected = await policy(),
    index = await owner(selected)
  await index.put(0, member('01', 100))
  await index.seal()
  const directory = join(selected.privateParent, (await readdir(selected.privateParent))[0]),
    file = await open(join(directory, 'keys'), 'r+')
  try {
    await file.write(Buffer.from([255]), 0, 1, 16)
  } finally {
    await file.close()
  }
  await expect(index.lookup(0, '01')).rejects.toThrow('integrity')
  await index.close()
})

test('actual UTF8 JSON archive bytes match the independent legacy projector and canonical writer', async () => {
  const history = '{"z":false,"notes":[{"other":null,"what":"' + '😄é'.repeat(2000) + '"}],"a":null,"a":7,"z":true}',
    bytes = Buffer.from(history),
    selected = await policy({ sourceBytes: bytes.length }),
    index = await owner(selected)
  const chunks: Uint8Array[] = []
  for await (const chunk of canonicalBrc38StructuredJson(
    'history',
    {
      encoding: 'utf8',
      length: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      read: async (offset, length) => Uint8Array.from(bytes.subarray(offset, offset + length)),
      openIndex: async () => index
    },
    { maximumInputBytes: bytes.length, maximumOutputBytes: bytes.length * 2, maximumChunkBytes: 64 }
  )) {
    expect(chunk.length).toBeLessThanOrEqual(64)
    chunks.push(chunk)
  }
  const original = projectBrc38PackedRow('provenTxReqs', { history }, { maximumAllocationBytes: 1000000 })
  expect(Buffer.concat(chunks).toString('utf8')).toBe(
    Buffer.concat([...canonicalPortableChunks(original.history, { maximumValueBytes: 1000000 })]).toString('utf8')
  )
  expect(await readdir(selected.privateParent)).toEqual([])
})

test('empty objects seal without a whole-map allocation and original lifetime does not renew', async () => {
  const selected = await policy(),
    index = await owner(selected)
  await index.seal()
  expect(await entries(index, 0)).toEqual([])
  const now = jest.spyOn(Date, 'now').mockReturnValue(selected.expiresAt)
  try {
    await expect(entries(index, 0)).rejects.toBeInstanceOf(SnapshotResourceLimitError)
  } finally {
    now.mockRestore()
  }
  await index.close()
  expect(await readdir(selected.privateParent)).toEqual([])
})

test('caller budget mutation cannot enlarge aggregate actual file limits and failure still cleans up', async () => {
  const selected = await policy({ maximumTemporaryFileBytes: 1048576 }),
    index = await owner(selected)
  selected.maximumTemporaryFileBytes = 17179869184
  const key = 'k'.repeat(8192)
  let failure: unknown
  for (let sequence = 0; sequence < 100; sequence++) {
    try {
      await index.put(0, member(key, 10 + sequence * 3))
    } catch (error) {
      failure = error
      break
    }
  }
  expect(failure).toBeInstanceOf(SnapshotResourceLimitError)
  const children = await readdir(selected.privateParent),
    directory = join(selected.privateParent, children[0])
  let total = 0
  for (const name of await readdir(directory)) total += (await lstat(join(directory, name))).size
  expect(total).toBeLessThanOrEqual(1048576)
  await expect(index.seal()).rejects.toThrow()
  await index.close()
  expect(await readdir(selected.privateParent)).toEqual([])
})

test('same-sized derived file tampering is detected before index data is returned', async () => {
  const selected = await policy(),
    index = await owner(selected)
  await index.put(0, member('key', 1))
  await index.seal()
  const directory = join(selected.privateParent, (await readdir(selected.privateParent))[0])
  const name = (await readdir(directory)).find(name => name.startsWith('runs-') && name.endsWith('b'))!
  const file = await open(join(directory, name), 'r+')
  try {
    await file.write(Buffer.from([255]), 0, 1, 10)
  } finally {
    await file.close()
  }
  await expect(entries(index, 0)).rejects.toThrow('integrity')
  await index.close()
  expect(await readdir(selected.privateParent)).toEqual([])
})

test('inode substitution is refused and physical cleanup refuses the foreign leaf until restored', async () => {
  const selected = await policy(),
    index = await owner(selected)
  const directory = join(selected.privateParent, (await readdir(selected.privateParent))[0]),
    filename = join(directory, 'input')
  // Preserve the actual file through a hard link so cleanup can be retried on
  // the same inode; a foreign path must never be recursively deleted by owner.
  const { link, rename } = await import('node:fs/promises'),
    retained = join(directory, 'retained')
  await link(filename, retained)
  await unlink(filename)
  const foreign = await open(filename, 'wx', 0o600)
  await foreign.close()
  await expect(index.put(0, member('key', 1))).rejects.toThrow('identity')
  await expect(index.close()).rejects.toThrow('cleanup')
  expect((await lstat(filename)).isFile()).toBe(true)
  await unlink(filename)
  await rename(retained, filename)
  await index.close()
  expect(await readdir(selected.privateParent)).toEqual([])
})

test('abort revokes admission while actual file cleanup remains available', async () => {
  const controller = new AbortController(),
    selected = await policy({ signal: controller.signal }),
    index = await owner(selected),
    reason = new Error('original abort')
  controller.abort(reason)
  await expect(index.put(0, member('key', 1))).rejects.toBe(reason)
  await index.close()
  expect(await readdir(selected.privateParent)).toEqual([])
})

test('one operation owns admission and close drains it without issuing a second writer', async () => {
  const selected = await policy(),
    index = await owner(selected)
  const pending = index.put(0, member('first', 1)),
    later = index.put(0, member('second', 10))
  await expect(later).rejects.toThrow('already owns')
  await pending
  const sealing = index.seal(),
    close = index.close()
  await expect(sealing).rejects.toThrow('revoked')
  await close
  expect(await readdir(selected.privateParent)).toEqual([])
})

test('nonprivate and symlink parents refuse before creating index files', async () => {
  const selected = await policy()
  await chmod(selected.privateParent, 0o755)
  await expect(Brc38NodeJsonIndex.open(selected)).rejects.toThrow(/private.*(?:owned|ownership)/i)
  await chmod(selected.privateParent, 0o700)
  const alias = selected.privateParent + '-alias'
  await symlink(selected.privateParent, alias)
  try {
    await expect(Brc38NodeJsonIndex.open({ ...selected, privateParent: alias })).rejects.toThrow(
      'Actual private file type or link count differs'
    )
  } finally {
    await unlink(alias)
  }
  expect(await readdir(selected.privateParent)).toEqual([])
})

test('erased private constructor and copied instances cannot issue index ownership', async () => {
  expect(() => Reflect.construct(Brc38NodeJsonIndex, [{}, {}, '/unused', {}, 0, []])).toThrow('fresh private factory')
  const selected = await policy(),
    index = await owner(selected),
    copied = { ...index }
  expect(() => Reflect.apply(Brc38NodeJsonIndex.prototype.seal, copied, [])).toThrow()
  await expect(index.put(0, member('x'.repeat(8193), 1))).rejects.toThrow('key')
  await index.put(0, member('valid', 1))
  await index.seal()
  expect(await entries(index, 0)).toEqual([member('valid', 1)])
})

test('explicit physical reservation bounds merge files before the larger logical file ceiling and drains ownership', async () => {
  const selected = await policy({ maximumTemporaryFileBytes: 8388608, maximumTemporaryPhysicalBytes: 1048576 }),
    index = await owner(selected)
  await expect(
    (async () => {
      for (let n = 0; n < 100; n++)
        await index.put(0, member(String(n).padStart(3, '0') + 'x'.repeat(8000), 100 + 3 * n))
      await index.seal()
    })()
  ).rejects.toBeInstanceOf(SnapshotResourceLimitError)
  await index.close()
  expect(await readdir(selected.privateParent)).toEqual([])
})

test('original 64 KiB working allocation admits bounded merge passes and preserves duplicate ordering', async () => {
  const selected = await policy({ maximumAllocationBytes: 65536 }),
    index = await owner(selected),
    expected = new Map<string, Brc38JsonMember>(),
    tail = 'k'.repeat(4000)
  // Enough decoded key data to exceed the old fixed 256 KiB window. The bounded
  // path must externalize runs and merge them under the captured allocation.
  for (let ordinal = 0; ordinal < 41; ordinal++) {
    const key = String(40 - ordinal).padStart(3, '0') + tail,
      value = member(key, 1000 + ordinal * 3)
    expected.set(key, value)
    await index.put(0, value)
  }
  const duplicate = [...expected.keys()][0],
    last = member(duplicate, 5000)
  expected.set(duplicate, last)
  await index.put(0, last)
  // Mutating caller policy cannot widen the admitted index or its window.
  selected.maximumAllocationBytes = 16777216
  await index.seal()
  expect(await entries(index, 0)).toEqual([...expected.keys()].sort().map(key => expected.get(key)))
  expect(await index.lookup(0, duplicate)).toEqual({ ...last, firstKeyOffset: 1000 })
  await index.close()
  expect(await readdir(selected.privateParent)).toEqual([])
})

test('working allocation refuses a decoded key before writing its serialized record', async () => {
  const selected = await policy({ maximumAllocationBytes: 8192 }),
    index = await owner(selected)
  selected.maximumAllocationBytes = 16777216
  await expect(index.put(0, member('a'.repeat(2000), 100))).rejects.toBeInstanceOf(SnapshotResourceLimitError)
  const directory = join(selected.privateParent, (await readdir(selected.privateParent))[0])
  for (const leaf of await readdir(directory)) expect((await lstat(join(directory, leaf))).size).toBe(0)
  await index.put(0, member('fits', 200))
  await index.seal()
  expect(await entries(index, 0)).toEqual([member('fits', 200)])
  await index.close()
})

test('optional working allocation is validated before filesystem acquisition', async () => {
  const selected = await policy()
  for (const maximumAllocationBytes of [0, 4095, 16777217, NaN, Infinity, 8192.5])
    await expect(Brc38NodeJsonIndex.open({ ...selected, maximumAllocationBytes })).rejects.toThrow(RangeError)
  expect(await readdir(selected.privateParent)).toEqual([])
})

test('two actual idle indexes share the original ceiling and refuse before a record is written', async () => {
  const workingAllocation = new Brc38WorkingAllocation(16384),
    selected = await policy({ maximumAllocationBytes: 16384, workingAllocation }),
    first = await owner(selected),
    firstReservation = workingAllocation.used,
    second = await owner(selected),
    sizes = async () => {
      const values: Array<readonly [string, number]> = []
      for (const directory of (await readdir(selected.privateParent)).sort())
        for (const name of (await readdir(join(selected.privateParent, directory))).sort())
          values.push([directory + '/' + name, (await lstat(join(selected.privateParent, directory, name))).size])
      return values
    },
    before = await sizes()
  expect(firstReservation).toBeGreaterThanOrEqual(4096)
  expect(workingAllocation.used).toBe(2 * firstReservation)
  await expect(first.put(0, member('x'.repeat(1200), 10))).rejects.toThrow(SnapshotResourceLimitError)
  expect(await sizes()).toEqual(before)
  expect(workingAllocation.used).toBe(2 * firstReservation)
  await second.close()
  await first.put(0, member('x'.repeat(1200), 10))
  expect(workingAllocation.used).toBeGreaterThan(4096)
  await first.close()
  expect(workingAllocation.used).toBe(0)
})
