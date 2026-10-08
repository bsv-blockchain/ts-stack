import { createHash } from 'node:crypto'
import { canonicalOutputJSON, outputHex32, parseOutputChain, type OutputChain, type OutputWalletFundingOperation } from '@bsv/sdk'
import type { TrxToken } from '../../sdk/WalletStorage.interfaces'
import { StorageKnex } from '../StorageKnex'
import { genesisHeader } from '../../services/chaintracker/chaintracks/util/blockHeaderUtilities'
import { isManagedChangeOutput } from '../methods/managedChange'
import {
  FUNDING_RECOVERY_RECORD_BYTES, fundingRecoverySemantic, parseFundingRecoveryOperation, requireFunding,
  type FundingRecoveryCommit, type FundingRecoveryReceipt, type FundingRecoveryResult
} from './FundingRecoveryProtocol'

const records = 'wallet_funding_recovery_v1'
const metadata = 'wallet_funding_recovery_metadata_v1'
const defaults = Object.freeze({ records: 4096, bytes: 64 * 1024 * 1024 })
const reservationBytes = FUNDING_RECOVERY_RECORD_BYTES + 4096

interface Metadata {
  id: number
  version: number
  chain: string
  storageIdentity: string
  maximumRecords: number
  maximumBytes: number
  usedRecords: number
  guard: number
}
interface Row {
  id: string
  userId: number
  semantic: string
  operation: string
  fundingKey: string
  receipt: string | null
  rejected: number
}

/** Same-database auxiliary journal. It is not part of legacy entity sync/backup. */
export class SQLiteFundingRecoveryStore {
  private constructor(readonly storage: StorageKnex, readonly chain: OutputChain) {}

  static async install(storage: StorageKnex, chainInput: OutputChain, limits: Readonly<{ records: number; bytes: number }> = defaults): Promise<SQLiteFundingRecoveryStore> {
    limits = { records: limits.records, bytes: limits.bytes }
    const chain = Object.freeze(parseOutputChain(chainInput))
    requireFunding(storage.getSettings().dbtype === 'SQLite' && chain.network === storage.getSettings().chain, 'Funding recovery requires matching local SQLite storage')
    requireFunding(storage.getSettings().chain === 'mock' || chain.genesisHash === genesisHeader(storage.getSettings().chain).hash, 'Funding recovery genesis differs from the wallet network')
    requireFunding(Number.isSafeInteger(limits.records) && limits.records > 0 && limits.records <= defaults.records && Number.isSafeInteger(limits.bytes) && limits.bytes >= reservationBytes && limits.bytes <= defaults.bytes, 'Invalid funding recovery capacity')
    await storage.transaction(async trx => {
      const db = storage.toDb(trx)
      const hasMetadata = await db.schema.hasTable(metadata), hasRecords = await db.schema.hasTable(records)
      requireFunding(hasMetadata === hasRecords, 'Incomplete funding recovery schema')
      if (!hasMetadata) {
        await db.schema.createTable(metadata, table => {
          table.integer('id').primary()
          for (const name of ['version', 'maximumRecords', 'maximumBytes', 'usedRecords', 'guard']) table.integer(name).notNullable()
          table.text('chain').notNullable()
          table.text('storageIdentity').notNullable()
        })
        await db.schema.createTable(records, table => {
          table.string('id', 64).primary()
          table.integer('userId').notNullable()
          table.text('semantic').notNullable()
          table.text('operation').notNullable()
          table.string('fundingKey', 64).notNullable().unique()
          table.text('receipt').nullable()
          table.integer('rejected').notNullable()
        })
        await db(metadata).insert({ id: 1, version: 1, chain: canonicalOutputJSON(chain), storageIdentity: storage.getSettings().storageIdentityKey, maximumRecords: limits.records, maximumBytes: limits.bytes, usedRecords: 0, guard: 0 })
      }
      const row = await new SQLiteFundingRecoveryStore(storage, chain).configuration(trx)
      requireFunding(row.maximumRecords === limits.records && row.maximumBytes === limits.bytes, 'Funding recovery capacity differs from installed configuration')
    })
    return await SQLiteFundingRecoveryStore.open(storage, chain)
  }

  static async open(storage: StorageKnex, chainInput: OutputChain): Promise<SQLiteFundingRecoveryStore> {
    const chain = Object.freeze(parseOutputChain(chainInput))
    requireFunding(storage.getSettings().dbtype === 'SQLite' && chain.network === storage.getSettings().chain, 'Funding recovery requires matching local SQLite storage')
    requireFunding(storage.getSettings().chain === 'mock' || chain.genesisHash === genesisHeader(storage.getSettings().chain).hash, 'Funding recovery genesis differs from the wallet network')
    const store = new SQLiteFundingRecoveryStore(storage, chain)
    await storage.transaction(async trx => {
      const row = await store.configuration(trx)
      const count = await storage.toDb(trx)(records).count({ count: '*' }).first()
      requireFunding(Number(count?.count) === row.usedRecords, 'Funding recovery accounting differs from retained records')
    })
    return store
  }

  private async configuration(trx?: TrxToken): Promise<Metadata> {
    const row: Metadata | undefined = await this.storage.toDb(trx)(metadata).where({ id: 1 }).first()
    requireFunding(row?.version === 1 && row.chain === canonicalOutputJSON(this.chain) && row.storageIdentity === this.storage.getSettings().storageIdentityKey, 'Missing or incompatible funding recovery configuration')
    for (const value of [row.maximumRecords, row.maximumBytes, row.usedRecords, row.guard]) requireFunding(Number.isSafeInteger(value) && value >= 0, 'Corrupt funding recovery accounting')
    requireFunding(row.maximumRecords > 0 && row.maximumRecords <= defaults.records && row.maximumBytes >= reservationBytes && row.maximumBytes <= defaults.bytes && row.usedRecords <= row.maximumRecords && row.usedRecords * reservationBytes <= row.maximumBytes, 'Corrupt funding recovery capacity')
    return row
  }

  private async lock(trx: TrxToken): Promise<Metadata> {
    const db = this.storage.toDb(trx)
    requireFunding(db.isTransaction === true && db.client.config.connection.filename === this.storage.knex.client.config.connection.filename, 'Funding recovery requires its own wallet transaction')
    requireFunding(await db(metadata).where({ id: 1 }).where('guard', '<', Number.MAX_SAFE_INTEGER).increment('guard', 1) === 1, 'Funding recovery store unavailable')
    return await this.configuration(trx)
  }

  private async user(userId: number, walletIdentity: string): Promise<void> {
    requireFunding(Number.isSafeInteger(userId) && userId > 0, 'Invalid funding recovery user')
    const users = await this.storage.findUsers({ partial: { userId, identityKey: walletIdentity } })
    requireFunding(users.length === 1, 'Funding recovery wallet binding mismatch')
  }

  /** Retains the exact initial intent before any verification or wallet effect. */
  async retain(userId: number, walletIdentity: string, input: OutputWalletFundingOperation): Promise<FundingRecoveryCommit> {
    const operation = parseFundingRecoveryOperation(input)
    requireFunding(operation.seller === walletIdentity && canonicalOutputJSON(operation.funding.chain) === canonicalOutputJSON(this.chain), 'Funding recovery seller or chain mismatch')
    await this.user(userId, walletIdentity)
    const semantic = fundingRecoverySemantic(operation)
    const fundingKey = createHash('sha256').update(canonicalOutputJSON(operation.funding)).digest('hex')
    await this.storage.transaction(async trx => {
      const config = await this.lock(trx)
      const prior = await this.readRow(userId, operation.id, trx)
      if (prior !== undefined) {
        requireFunding(prior.semantic === semantic, 'Funding recovery operation conflicts with retained intent')
        return
      }
      const assigned = await this.storage.toDb(trx)(records).where({ fundingKey }).first()
      requireFunding(assigned === undefined, 'Funding output is already assigned to another operation')
      requireFunding(config.usedRecords < config.maximumRecords && (config.usedRecords + 1) * reservationBytes <= config.maximumBytes, 'Funding recovery capacity exhausted')
      await this.storage.toDb(trx)(records).insert({ id: operation.id, userId, semantic, operation: canonicalOutputJSON(operation), fundingKey, receipt: null, rejected: 0 })
      await this.storage.toDb(trx)(metadata).where({ id: 1 }).increment('usedRecords', 1)
    })
    return {
      protocol: 'wallet-funding-recovery-v1',
      reject: async () => await this.storage.transaction(async trx => {
        await this.lock(trx)
        const row = await this.readRow(userId, operation.id, trx)
        requireFunding(row?.semantic === semantic && row.receipt === null, 'Accepted or absent funding cannot be rejected')
        await this.storage.toDb(trx)(records).where({ id: operation.id }).update({ rejected: 1 })
      }),
      commit: async run => await this.storage.transaction(async trx => {
        await this.lock(trx)
        const row = await this.readRow(userId, operation.id, trx)
        requireFunding(row?.semantic === semantic, 'Funding recovery intent is absent or changed')
        requireFunding(row.rejected === 0, 'Rejected funding cannot be credited')
        if (row.receipt !== null) return { accepted: true, isMerge: true, txid: operation.funding.txid, satoshis: 0 }
        const result = await run(trx)
        requireFunding(result.accepted && result.txid === operation.funding.txid && result.sendWithResults === undefined && result.notDelayedResults === undefined, 'Funding recovery did not finish ownership writes')
        const transactions = await this.storage.findTransactions({ partial: { userId, txid: result.txid }, trx, noRawTx: true })
        requireFunding(transactions.length === 1, 'Funding recovery transaction is absent')
        const outputs = await this.storage.findOutputs({ partial: { userId, txid: result.txid, vout: operation.funding.outputIndex }, trx })
        requireFunding(outputs.length === 1 && isManagedChangeOutput(outputs[0]) && outputs[0].satoshis.toString() === operation.satoshis && outputs[0].derivationPrefix === operation.derivationPrefix && outputs[0].derivationSuffix === operation.derivationSuffix && outputs[0].senderIdentityKey === operation.buyer, 'Funding recovery ownership does not match retained intent')
        const receipt: FundingRecoveryReceipt = { protocol: 'wallet-funding-recovery-v1', operationId: operation.id, funding: operation.funding, satoshis: operation.satoshis, walletIdentity, storageIdentity: this.storage.getSettings().storageIdentityKey, transactionId: transactions[0].transactionId }
        const encoded = canonicalOutputJSON(receipt, { bytes: 4096 })
        requireFunding(await this.storage.toDb(trx)(records).where({ id: operation.id, receipt: null }).update({ receipt: encoded, operation: canonicalOutputJSON(operation) }) === 1, 'Funding recovery receipt did not commit')
        return result
      })
    }
  }

  async getInternalization(userId: number, walletIdentity: string, id: string): Promise<FundingRecoveryResult> {
    outputHex32(id)
    await this.user(userId, walletIdentity)
    await this.configuration()
    const row = await this.readRow(userId, id)
    if (row === undefined) return { state: 'absent' }
    const operation = parseFundingRecoveryOperation(JSON.parse(row.operation))
    requireFunding(operation.seller === walletIdentity, 'Funding recovery receipt belongs to another wallet')
    if (row.rejected === 1) return { state: 'rejected', reason: 'payment-script-mismatch' }
    if (row.receipt === null) return { state: 'unknown' }
    const receipt = JSON.parse(row.receipt) as FundingRecoveryReceipt
    requireFunding(Number.isSafeInteger(receipt.transactionId) && receipt.transactionId > 0 && canonicalOutputJSON(receipt) === canonicalOutputJSON({ protocol: 'wallet-funding-recovery-v1', operationId: operation.id, funding: operation.funding, satoshis: operation.satoshis, walletIdentity, storageIdentity: this.storage.getSettings().storageIdentityKey, transactionId: receipt.transactionId }), 'Corrupt funding recovery receipt')
    return { state: 'accepted', funding: operation.funding, receipt }
  }

  private async readRow(userId: number, id: string, trx?: TrxToken): Promise<Row | undefined> {
    const row: Row | undefined = await this.storage.toDb(trx)(records).where({ id }).first()
    if (row === undefined) return undefined
    requireFunding(row.userId === userId && typeof row.operation === 'string' && row.operation.length <= FUNDING_RECOVERY_RECORD_BYTES && (row.receipt === null || (typeof row.receipt === 'string' && row.receipt.length <= 4096)), 'Corrupt or inaccessible funding recovery record')
    requireFunding((row.rejected === 0 || row.rejected === 1) && (row.rejected === 0 || row.receipt === null), 'Corrupt funding recovery outcome')
    const operation = parseFundingRecoveryOperation(JSON.parse(row.operation))
    requireFunding(operation.id === id && row.semantic === fundingRecoverySemantic(operation) && row.fundingKey === createHash('sha256').update(canonicalOutputJSON(operation.funding)).digest('hex'), 'Funding recovery record binding differs')
    return row
  }
}
