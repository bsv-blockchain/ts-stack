import { observeWalletSnapshotFieldReader } from './observeWalletSnapshotFieldReader'
import type { WalletSnapshotFieldReader } from './WalletReadSnapshot'

// Authored UNRUN. The observer preserves the original reader's authority,
// errors and actual returned byte ownership; counts are telemetry DATA only.
test('field telemetry counts successful repeated extents without copying or changing the original receiver', async () => {
  const bytes = new Uint8Array([1, 2, 3]),
    calls: unknown[][] = [],
    reader: WalletSnapshotFieldReader = {
      readMetadataPage: async () => ({ rows: [], payloadBytes: 4096, done: true }),
      async readFieldExtent(...args) {
        expect(this).toBe(reader)
        calls.push(args)
        return bytes
      }
    },
    observed = observeWalletSnapshotFieldReader(reader),
    cursor = {
      version: 1 as const,
      snapshotId: 'aa'.repeat(32),
      table: 'transactions' as const,
      after: [1]
    },
    descriptor = { kind: 'binary' as const, bytes: 3 }
  expect(observed.extentBytesRead).toBe(0)
  await observed.readMetadataPage('transactions')
  expect(observed.extentBytesRead).toBe(0)
  for (let replay = 0; replay < 2; replay++)
    expect(await observed.readFieldExtent('transactions', cursor, 'rawTx', 0, 3, descriptor)).toBe(bytes)
  expect(observed.extentBytesRead).toBe(6)
  expect(calls).toEqual(Array.from({ length: 2 }, () => ['transactions', cursor, 'rawTx', 0, 3, descriptor]))
  bytes.fill(0)
  expect(bytes).toEqual(new Uint8Array(3))
})

test('a source failure remains authoritative and does not charge a returned extent', async () => {
  const failure = new Error('Original source expired'),
    reader: WalletSnapshotFieldReader = {
      readMetadataPage: async () => {
        throw failure
      },
      readFieldExtent: async () => {
        throw failure
      }
    },
    observed = observeWalletSnapshotFieldReader(reader)
  await expect(observed.readMetadataPage('transactions')).rejects.toBe(failure)
  await expect(
    observed.readFieldExtent(
      'transactions',
      {
        version: 1,
        snapshotId: 'aa'.repeat(32),
        table: 'transactions',
        after: [1]
      },
      'rawTx',
      0,
      3,
      { kind: 'binary', bytes: 3 }
    )
  ).rejects.toBe(failure)
  expect(observed.extentBytesRead).toBe(0)
})
