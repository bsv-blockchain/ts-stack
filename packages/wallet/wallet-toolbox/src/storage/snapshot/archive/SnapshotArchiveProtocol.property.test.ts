import fc from 'fast-check'
import { createHash } from 'node:crypto'
import {
  parseSnapshotArchiveRpcInput,
  snapshotArchiveMethods,
  validateSnapshotArchiveRequestReceipt,
  type SnapshotArchiveMethod
} from './SnapshotArchiveProtocol'
import { SnapshotArchiveTransport } from './SnapshotArchiveTransport'

const MIN_PROPERTY_RUNS = 300
const requestedRuns = Number.parseInt(process.env.FAST_CHECK_NUM_RUNS ?? '', 10)
const requestedSeed = Number.parseInt(process.env.FAST_CHECK_SEED ?? '', 10)
const replayPath = process.env.FAST_CHECK_PATH
fc.configureGlobal({
  numRuns: Number.isSafeInteger(requestedRuns) ? Math.max(MIN_PROPERTY_RUNS, requestedRuns) : MIN_PROPERTY_RUNS,
  ...(Number.isSafeInteger(requestedSeed) ? { seed: requestedSeed } : {}),
  ...(replayPath !== undefined && replayPath !== '' ? { path: replayPath } : {})
})

test('generated protocol requests preserve exact identity, deadlines and terminal states through client validation', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.uint8Array({ minLength: 32, maxLength: 32 }),
      fc.integer({ min: 1, max: 3600000 }),
      fc.integer({ min: 4097, max: 32 * 1024 * 1024 }),
      fc.constantFrom('building', 'closed', 'failed', 'expired', 'resource-limited', 'ready'),
      fc.constantFrom(...snapshotArchiveMethods),
      async (bytes, duration, maxBytes, state, method) => {
        const nonce = Buffer.from(bytes).toString('hex')
        const identityKey = '02' + nonce
        const notAfter = 1790726400000 + duration
        const requestId = createHash('sha256')
          .update(JSON.stringify(['wallet-snapshot-request/1', 1, nonce, notAfter, maxBytes]))
          .digest('hex')
        const request = { version: 1 as const, nonce, notAfter, maxBytes, requestId }
        const readerRequest = {
          version: 2 as const,
          nonce,
          notAfter,
          maxBytes,
          requestId: createHash('sha256')
            .update(JSON.stringify(['wallet-snapshot-reader-request/1', 2, nonce, notAfter, maxBytes]))
            .digest('hex')
        }
        const archiveId = createHash('sha256')
          .update('archive:' + nonce)
          .digest('hex')
        const digest = createHash('sha256')
          .update('directory:' + nonce)
          .digest('hex')
        const receipt = {
          version: 1,
          requestId,
          expiresAt: notAfter,
          state,
          ...(state === 'ready' ? { archiveId, digest } : {})
        }
        const rpc = jest.fn(async (_method: string, _params: unknown[]) => receipt)
        const transport = new SnapshotArchiveTransport(rpc, identityKey, 'source', 'test')
        expect(await transport.start(request)).toEqual(receipt)
        expect(await transport.status(request)).toEqual(receipt)
        expect(rpc.mock.calls[0]).toEqual(['startSnapshotArchive', [{ version: 1, identityKey, request }], undefined])
        const extras: Record<SnapshotArchiveMethod, object> = {
          getSnapshotArchiveReaderOffer: { options: { lifetimeMs: duration, maxBytes } },
          admitSnapshotArchive: { request: readerRequest },
          cancelSnapshotArchiveRequest: { request: readerRequest },
          getSnapshotArchiveOffer: {},
          startSnapshotArchive: { request },
          getSnapshotArchiveStatus: { requestId },
          cancelSnapshotArchive: { requestId },
          getSnapshotArchiveDirectory: { archiveId },
          readSnapshotArchivePage: { archiveId, sequence: duration % 4096 }
        }
        const extra = extras[method]
        const input = { version: 1, identityKey, ...extra }
        expect(parseSnapshotArchiveRpcInput(method, [input])).toEqual({ method, identityKey, ...extra })
        expect(() => parseSnapshotArchiveRpcInput(method, [{ ...input, claimToken: nonce }])).toThrow()
        expect(() => validateSnapshotArchiveRequestReceipt({ ...receipt, expiresAt: notAfter + 1 }, request)).toThrow()
        expect(() => validateSnapshotArchiveRequestReceipt({ ...receipt, requestId: archiveId }, request)).toThrow()
        expect(() => validateSnapshotArchiveRequestReceipt({ ...receipt, writerToken: nonce }, request)).toThrow()
      }
    )
  )
})
