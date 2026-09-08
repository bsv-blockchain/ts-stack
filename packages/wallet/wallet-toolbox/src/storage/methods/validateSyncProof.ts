import { MerklePath, Transaction } from '@bsv/sdk'
import { WERR_INVALID_PARAMETER } from '../../sdk/WERR_errors'
import { WalletServices } from '../../sdk/WalletServices.interfaces'
import { doubleSha256BE } from '../../utility/utilityHelpers'
import { asString } from '../../utility/utilityHelpers.noBuffer'
import { TableProvenTx } from '../schema/tables/TableProvenTx'

interface SyncProofValidationStorage {
  getServices: () => WalletServices
}

const replacementAuthorized = new WeakSet<TableProvenTx>()
const insertOnly = new WeakSet<TableProvenTx>()

function equalBytes(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

function invalidSyncProof(message: string): never {
  throw new WERR_INVALID_PARAMETER('provenTx', `a server-verified proof. ${message}`)
}

/** Normalize text-key identifiers before lookup or persistence. */
export function canonicalizeSyncProofIdentifiers(candidate: TableProvenTx): void {
  if (!/^[0-9a-f]{64}$/i.test(candidate.txid)) invalidSyncProof('txid must be 32-byte hexadecimal')
  if (!/^[0-9a-f]{64}$/i.test(candidate.blockHash)) {
    invalidSyncProof('block hash must be 32-byte hexadecimal')
  }
  if (!/^[0-9a-f]{64}$/i.test(candidate.merkleRoot)) {
    invalidSyncProof('Merkle root must be 32-byte hexadecimal')
  }
  candidate.txid = candidate.txid.toLowerCase()
  candidate.blockHash = candidate.blockHash.toLowerCase()
  candidate.merkleRoot = candidate.merkleRoot.toLowerCase()
}

/** Compare proof authority fields, excluding local IDs and timestamps. */
export function sameSyncProof(a: TableProvenTx, b: TableProvenTx): boolean {
  return a.txid.toLowerCase() === b.txid.toLowerCase() &&
    a.height === b.height &&
    a.index === b.index &&
    equalBytes(a.merklePath, b.merklePath) &&
    equalBytes(a.rawTx, b.rawTx) &&
    a.blockHash.toLowerCase() === b.blockHash.toLowerCase() &&
    a.merkleRoot.toLowerCase() === b.merkleRoot.toLowerCase()
}

/** Record that preflight found no row which this candidate may replace. */
export function markSyncProofInsertOnly(candidate: TableProvenTx): void {
  insertOnly.add(candidate)
}

/**
 * Enforce the pre-transaction proof decision again at the entity merge point.
 * This closes the race where another process inserts the txid after preflight.
 */
export function assertSyncProofReplacementAuthorized(candidate: TableProvenTx): void {
  if (replacementAuthorized.has(candidate)) return
  if (insertOnly.has(candidate)) {
    invalidSyncProof('a concurrent proof row appeared; retry synchronization')
  }
  invalidSyncProof('replacement requires active-chain validation')
}

/**
 * Validate proof authority before an RPC proof is admitted or an in-process
 * backup/conflict proof replaces an existing global row. Network-backed checks
 * run before the storage merge transaction is opened.
 */
export async function validateSyncProof(
  storage: SyncProofValidationStorage,
  candidate: TableProvenTx
): Promise<void> {
  canonicalizeSyncProofIdentifiers(candidate)
  if (!Number.isSafeInteger(candidate.height) || candidate.height < 0) {
    invalidSyncProof('height must be a non-negative safe integer')
  }
  if (!Number.isSafeInteger(candidate.index) || candidate.index < 0) {
    invalidSyncProof('index must be a non-negative safe integer')
  }
  if (!Array.isArray(candidate.rawTx) || candidate.rawTx.length === 0) {
    invalidSyncProof('raw transaction is required')
  }
  if (!Array.isArray(candidate.merklePath) || candidate.merklePath.length === 0) {
    invalidSyncProof('Merkle path is required')
  }

  try {
    const parsed = Transaction.fromBinary(candidate.rawTx)
    const rawTxid = asString(doubleSha256BE(candidate.rawTx))
    if (parsed.id('hex') !== rawTxid || rawTxid !== candidate.txid.toLowerCase()) {
      invalidSyncProof('raw transaction hash does not match txid')
    }

    const proof = MerklePath.fromBinary(candidate.merklePath)
    if (proof.blockHeight !== candidate.height) invalidSyncProof('Merkle path height does not match the record')
    const leaf = proof.path[0]?.find(item => item.txid === true && item.hash === candidate.txid.toLowerCase())
    if (leaf?.offset !== candidate.index) {
      invalidSyncProof('Merkle path does not contain the transaction at the recorded index')
    }
    const root = proof.computeRoot(candidate.txid.toLowerCase())
    if (root !== candidate.merkleRoot.toLowerCase()) invalidSyncProof('computed Merkle root does not match the record')

    const services = storage.getServices()
    const chainTracker = await services.getChainTracker()
    if (!(await chainTracker.isValidRootForHeight(root, candidate.height))) {
      invalidSyncProof('Merkle root is not active at the recorded height')
    }

    const header = await services.getHeaderForHeight(candidate.height)
    if (header.length !== 80) invalidSyncProof('active block header must be 80 bytes')
    const activeHash = asString(doubleSha256BE(header))
    const activeMerkleRoot = asString(header.slice(36, 68).reverse())
    if (activeHash !== candidate.blockHash.toLowerCase() || activeMerkleRoot !== root) {
      invalidSyncProof('block metadata does not match the active header')
    }
    replacementAuthorized.add(candidate)
  } catch (error) {
    if (error instanceof WERR_INVALID_PARAMETER) throw error
    invalidSyncProof('transaction, Merkle path, or active header could not be validated')
  }
}
