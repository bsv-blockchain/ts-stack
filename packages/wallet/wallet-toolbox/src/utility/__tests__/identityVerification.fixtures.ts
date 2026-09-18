import {
  ChainTracker,
  MerklePath,
  P2PKH,
  PrivateKey,
  ProtoWallet,
  PushDrop,
  Script,
  Transaction,
  Utils,
  VerifiableCertificate
} from '@bsv/sdk'
import { createHash } from 'node:crypto'
import fixtureJson from './fixtures/identity-verification.json'

// Synthetic fixture: fixed subject/certifier keys 11/12; pinned BEEF SHA-256 is checked before use.

export const IDENTITY_VERIFICATION_PROTOCOL: [1, string] = [1, 'identity']
export const IDENTITY_VERIFICATION_KEY_ID = '1'
export const IDENTITY_VERIFICATION_CONFIRMED_HEIGHT = 700_000

/** A local canonical-root source used by identity verification fixtures. */
export class IdentityVerificationChainTracker implements ChainTracker {
  readonly roots = new Set<string>()
  readonly checkedRoots: Array<{ root: string; height: number }> = []

  async currentHeight(): Promise<number> {
    return IDENTITY_VERIFICATION_CONFIRMED_HEIGHT + 101
  }

  async isValidRootForHeight(root: string, height: number): Promise<boolean> {
    this.checkedRoots.push({ root, height })
    return height === IDENTITY_VERIFICATION_CONFIRMED_HEIGHT && this.roots.has(root)
  }
}

export interface IdentityVerificationFixture {
  certificate: VerifiableCertificate
  subjectWallet: ProtoWallet
  certificateTransaction: Transaction
  certificateBEEF: number[]
  confirmedTracker: IdentityVerificationChainTracker
  unconfirmedTransaction: Transaction
  unconfirmedBEEF: number[]
}

function sha256d(bytes: Uint8Array): Uint8Array {
  return createHash('sha256').update(createHash('sha256').update(bytes).digest()).digest()
}

/** Independent Node SHA-256d reference for a serialized transaction ID. */
export function fixtureTxidFromBytes(bytes: Uint8Array): string {
  return Buffer.from(sha256d(bytes)).reverse().toString('hex')
}

/** Independent Bitcoin Merkle reference over display-order transaction IDs. */
export function fixtureMerkleRoot(left: string, right: string): string {
  const leftLE = Buffer.from(left, 'hex').reverse()
  const rightLE = Buffer.from(right, 'hex').reverse()
  return Buffer.from(sha256d(Buffer.concat([leftLE, rightLE])))
    .reverse()
    .toString('hex')
}

/** Attach a two-leaf, non-coinbase proof and register its root in the local tracker. */
export function confirmIdentityFixtureTransaction(tx: Transaction, tracker: IdentityVerificationChainTracker): void {
  const txid = tx.id('hex')
  if (fixtureTxidFromBytes(tx.toUint8Array()) !== txid) throw new Error('SDK transaction ID disagrees with SHA-256d')
  const path = new MerklePath(IDENTITY_VERIFICATION_CONFIRMED_HEIGHT, [
    [
      { offset: 0, hash: '42'.repeat(32) },
      { offset: 1, hash: txid, txid: true }
    ]
  ])
  tx.merklePath = path
  const root = fixtureMerkleRoot('42'.repeat(32), txid)
  if (path.computeRoot(txid) !== root) throw new Error('SDK Merkle root disagrees with SHA-256d')
  tracker.roots.add(root)
}

/**
 * Builds a local, signed identity certificate in a subject-signed PushDrop output.
 * The returned unconfirmed transaction spends a separately confirmed P2PKH ancestor.
 */
export async function createIdentityVerificationFixture(): Promise<IdentityVerificationFixture> {
  const subjectWallet = new ProtoWallet(new PrivateKey(11))
  const certificateBEEF = Utils.toArray(fixtureJson.certificateBEEF, 'base64')
  if (createHash('sha256').update(Buffer.from(certificateBEEF)).digest('hex') !== fixtureJson.certificateBEEFSha256) {
    throw new Error('Identity fixture BEEF digest mismatch')
  }
  const certificateTransaction = Transaction.fromBEEF(certificateBEEF)
  const decoded = PushDrop.decode(certificateTransaction.outputs[0].lockingScript)
  const parsed = JSON.parse(Utils.toUTF8(decoded.fields[0]))
  const certificate = new VerifiableCertificate(
    parsed.type,
    parsed.serialNumber,
    parsed.subject,
    parsed.certifier,
    parsed.revocationOutpoint,
    parsed.fields,
    parsed.keyring,
    parsed.signature
  )
  const confirmedTracker = new IdentityVerificationChainTracker()
  const certificateTxid = fixtureTxidFromBytes(certificateTransaction.toUint8Array())
  const certificateRoot = fixtureMerkleRoot('42'.repeat(32), certificateTxid)
  if (
    certificateTransaction.id('hex') !== certificateTxid ||
    certificateTransaction.merklePath?.computeRoot(certificateTxid) !== certificateRoot
  ) {
    throw new Error('Pinned identity fixture does not match its SHA-256d references')
  }
  confirmedTracker.roots.add(certificateRoot)

  const spendingKey = new PrivateKey(13)
  const ancestor = new Transaction()
  ancestor.addInput({
    sourceTXID: '00'.repeat(32),
    sourceOutputIndex: 0,
    unlockingScript: Script.fromASM('OP_TRUE')
  })
  ancestor.addOutput({ satoshis: 10, lockingScript: new P2PKH().lock(spendingKey.toAddress()) })
  confirmIdentityFixtureTransaction(ancestor, confirmedTracker)

  const createCertificateSpend = async (): Promise<Transaction> => {
    const transaction = new Transaction()
    transaction.addInput({
      sourceTransaction: ancestor,
      sourceOutputIndex: 0,
      unlockingScriptTemplate: new P2PKH().unlock(spendingKey)
    })
    transaction.addOutput({ satoshis: 9, lockingScript: certificateTransaction.outputs[0].lockingScript })
    await transaction.sign()
    return transaction
  }
  const confirmedCertificateTransaction = await createCertificateSpend()
  confirmIdentityFixtureTransaction(confirmedCertificateTransaction, confirmedTracker)
  const unconfirmedTransaction = await createCertificateSpend()

  return {
    certificate,
    subjectWallet,
    certificateTransaction: confirmedCertificateTransaction,
    certificateBEEF: confirmedCertificateTransaction.toBEEF(),
    confirmedTracker,
    unconfirmedTransaction,
    unconfirmedBEEF: unconfirmedTransaction.toBEEF()
  }
}
