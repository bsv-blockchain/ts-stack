import { Beef, LockingScript, MerklePath, Transaction, UnlockingScript, Utils } from '@bsv/sdk'
import { SQLitePrivatePurchaseEvidence } from '../src/private/SQLitePrivatePurchaseEvidence.js'
import { purchaseStoreFixture } from './private-purchase-store.fixture.js'

/** Real native encrypted storage and deterministic raw/Merkle structures.
 * These unit fixtures do not install a chain or establish purchase/domain validity.
 * The coordinator separately requires both incoming and combined verification.
 */
export function purchaseEvidenceFixture(maximumUpdates = 4) {
  const base = purchaseStoreFixture(),
    original = base.custody.original,
    funding = new Transaction(
      1,
      [
        {
          sourceTXID: '00'.repeat(32),
          sourceOutputIndex: 0xffffffff,
          unlockingScript: UnlockingScript.fromHex('0101'),
          sequence: 0xffffffff
        }
      ],
      [{ satoshis: 1000, lockingScript: LockingScript.fromHex('51') }],
      0
    ),
    sibling = new Transaction(
      1,
      [
        {
          sourceTXID: '00'.repeat(32),
          sourceOutputIndex: 0xffffffff,
          unlockingScript: UnlockingScript.fromHex('0102'),
          sequence: 0xffffffff
        }
      ],
      [{ satoshis: 1000, lockingScript: LockingScript.fromHex('51') }],
      0
    ),
    path = new MerklePath(0, [
      [
        { offset: 0, hash: funding.id('hex'), txid: true },
        { offset: 1, hash: sibling.id('hex') }
      ]
    ]),
    target = new Transaction(
      1,
      [
        {
          sourceTransaction: funding,
          sourceOutputIndex: 0,
          unlockingScript: new UnlockingScript(),
          sequence: 0xffffffff
        }
      ],
      [{ satoshis: 999, lockingScript: LockingScript.fromHex('51') }],
      0
    )
  funding.merklePath = path
  const first = new Beef()
  first.mergeTransaction(target)
  const rich = Beef.fromBinaryStrict(first.toBinaryAtomic(target.id('hex')))
  sibling.merklePath = new MerklePath(0, [
    [
      { offset: 0, hash: funding.id('hex') },
      { offset: 1, hash: sibling.id('hex'), txid: true }
    ]
  ])
  rich.mergeTransaction(sibling)
  const candidate = {
      version: 1 as const,
      acquisitionId: original.terms.body.acquisitionId,
      txid: target.id('hex'),
      beef: Utils.toBase64(first.toBinaryAtomic(target.id('hex')))
    },
    alternate = { ...candidate, beef: Utils.toBase64(rich.toBinary()) },
    limits = {
      maximumCandidateBytes: 8192,
      maximumUpdates,
      maximumTransactions: 8,
      maximumDependencies: 8
    }
  const owner = new SQLitePrivatePurchaseEvidence(base.owner.domain, base.f.f.contracts, limits)
  const reopen = () => {
    const opened = base.open()
    return new SQLitePrivatePurchaseEvidence(opened.domain, base.f.f.contracts, limits)
  }
  return { base, original, limits, owner, reopen, candidate, alternate, path, target, first, rich }
}
