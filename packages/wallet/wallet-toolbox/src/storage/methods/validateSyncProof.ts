import { MerklePath, Transaction } from '@bsv/sdk'
import { WERR_INVALID_PARAMETER } from '../../sdk/WERR_errors'
import { WalletServices } from '../../sdk/WalletServices.interfaces'
import { doubleSha256BE } from '../../utility/utilityHelpers'
import { asString } from '../../utility/utilityHelpers.noBuffer'
import { TableProvenTx } from '../schema/tables/TableProvenTx'

interface SyncProofValidationStorage {
  getServices: () => WalletServices
}

function invalidSyncProof(message: string): never {
  throw new WERR_INVALID_PARAMETER('provenTx', `a server-verified proof. ${message}`)
}

/**
 * Validate a tenant-supplied proof before Knex opens the sync transaction.
 * This module is deliberately server-only so proof-authority checks do not
 * expand portable/browser storage bundles.
 */
export async function validateSyncProof(
  storage: SyncProofValidationStorage,
  candidate: TableProvenTx
): Promise<void> {
  if (!/^[0-9a-f]{64}$/i.test(candidate.txid)) invalidSyncProof('txid must be 32-byte hexadecimal')
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
  } catch (error) {
    if (error instanceof WERR_INVALID_PARAMETER) throw error
    invalidSyncProof('transaction, Merkle path, or active header could not be validated')
  }
}
