import { nativeTestExecutable } from './Brc38NativeTestPath'
import { composedFixtureChain, withComposedNativeFixture } from './Brc38ComposedNativeFixture'
import { verifyBrc38NativeLocalCurrentSource } from './Brc38NativeLocalBaselineSourceNode.case'
import { brc38DestinationSelection } from './Brc38KnexDestinationFence'
import { previewReceiptPolicy } from './Brc38ImportPreviewFixture'

// Admit the existing 180-second fixture owner plus 30 seconds of cleanup.
const nativeFixtureCaseTimeoutMs = 180000 + 30000

// Authored UNRUN. The source retains an actual WAL view while a genuine current
// writer commits. Each variant opens its own fully restored/published fixture.
test.each(['transaction', 'request-field', 'auxiliary', 'primary'] as const)(
  'native retained local view refuses a fresh current %s mutation',
  async kind => {
    await withComposedNativeFixture(async fixture => {
      const { storage, manager } = fixture,
        user = manager.getActiveUser(),
        selection = brc38DestinationSelection({
          identityKey: user.identityKey,
          chain: composedFixtureChain(storage),
          targetStorageIdentityKey: manager.getActiveStore(),
          mode: 'merge'
        }),
        check = (): void => {
          if (Date.now() >= fixture.expiresAt) throw new Error('Current-source fixture exceeded its original lifetime')
        }
      await verifyBrc38NativeLocalCurrentSource(
        storage,
        selection,
        previewReceiptPolicy,
        {
          maximumMetadataBytes: 65536,
          maximumReadBytes: 1024,
          expiresAt: fixture.expiresAt,
          workingAllocation: fixture.merge.workingAllocation
        },
        async () => {
          check()
          await manager.runAsStorageProvider(async active => {
            expect(active).toBe(storage)
            if (kind === 'transaction') {
              const rows = await storage.findTransactions({ partial: { userId: user.userId }, noRawTx: true })
              expect(rows).toHaveLength(1)
              expect(
                await storage.updateTransaction(rows[0].transactionId, {
                  updated_at: new Date('2026-10-08T00:00:01.000Z')
                })
              ).toBe(1)
            } else if (kind === 'request-field') {
              const rows = await storage.findProvenTxReqs({ partial: { txid: fixture.proof.txid.toUpperCase() } })
              expect(rows).toHaveLength(1)
              expect(
                await storage.updateProvenTxReq(rows[0].provenTxReqId, {
                  history: '{"notes":[{"when":"2026-10-08T00:00:01.000Z","what":"independent live history"}]}'
                })
              ).toBe(1)
            } else if (kind === 'auxiliary') {
              const when = new Date('2026-10-08T00:00:01.000Z')
              await storage.insertMonitorEvent({
                id: 0,
                created_at: when,
                updated_at: when,
                event: 'independent live auxiliary event',
                details: 'current payload 雪'
              })
            } else {
              const original = user.activeStorage
              expect(await storage.updateUser(user.userId, { activeStorage: 'independent other primary' })).toBe(1)
              expect(await storage.updateUser(user.userId, { activeStorage: original })).toBe(1)
            }
          })
          check()
        }
      )
      expect(fixture.merge.workingAllocation.used).toBe(0)
    }, nativeTestExecutable())
  },
  nativeFixtureCaseTimeoutMs
)
