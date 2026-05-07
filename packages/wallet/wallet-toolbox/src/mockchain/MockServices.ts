import {
  Beef,
  ChainTracker,
  Random,
  Transaction as BsvTransaction,
  Utils
} from '@bsv/sdk'
import { Knex } from 'knex'
import { Chain } from '../sdk/types'
import {
  BlockHeader,
  FiatExchangeRates,
  GetMerklePathResult,
  GetRawTxResult,
  GetScriptHashHistoryResult,
  GetStatusForTxidsResult,
  GetUtxoStatusOutputFormat,
  GetUtxoStatusResult,
  PostBeefResult,
  ServicesCallHistory,
  WalletServices
} from '../sdk/WalletServices.interfaces'
import type { FiatCurrencyCode } from '../sdk/WalletServices.interfaces'
import { TableOutput } from '../storage/schema/tables/TableOutput'
import { WERR_INTERNAL, WERR_INVALID_PARAMETER } from '../sdk/WERR_errors'
import { doubleSha256BE, sha256Hash } from '../utility/utilityHelpers'
import { asArray, asString } from '../utility/utilityHelpers.noBuffer'
import { toBinaryBaseBlockHeader, validateScriptHash } from '../services/Services'
import { MockChainStorage } from './MockChainStorage'
import { MockChainTracker } from './MockChainTracker'
import { MockMiner } from './MockMiner'
import { computeMerklePath } from './merkleTree'

const mockFiatRatesByUsd: Record<FiatCurrencyCode, number> = {
  USD: 1,
  EUR: 0.92,
  GBP: 0.79,
  JPY: 156.5,
  CNY: 7.24,
  INR: 83.42,
  AUD: 1.51,
  CAD: 1.37,
  CHF: 0.9,
  HKD: 7.81,
  SGD: 1.35,
  NZD: 1.64,
  SEK: 10.52,
  NOK: 10.74,
  MXN: 16.68
}

export interface ReorgResult {
  oldTip: BlockHeader
  newTip: BlockHeader
  deactivatedHeaders: BlockHeader[]
}

export class MockServices implements WalletServices {
  chain: Chain = 'mock'
  storage: MockChainStorage
  tracker: MockChainTracker
  miner: MockMiner

  constructor (public knex: Knex) {
    this.storage = new MockChainStorage(knex)
    this.tracker = new MockChainTracker('mock', this.storage)
    this.miner = new MockMiner()
  }

  async initialize (): Promise<void> {
    await this.storage.migrate()
    // Mine genesis block if chain is empty
    const tip = await this.storage.getChainTip()
    if (tip == null) {
      await this.miner.mineBlock(this.storage)
    }
  }

  async mineBlock (): Promise<BlockHeader> {
    return await this.miner.mineBlock(this.storage)
  }

  async postBeef (beef: Beef, txids: string[]): Promise<PostBeefResult[]> {
    const results: PostBeefResult[] = []
    for (const txid of txids) {
      try {
        await this.postOneTx(beef, txid)
        results.push({ name: 'MockServices', status: 'success', txidResults: [{ txid, status: 'success' }] })
      } catch (error_: unknown) {
        const error = error_ instanceof Error ? new WERR_INTERNAL(error_.message) : new WERR_INTERNAL(String(error_))
        results.push({ name: 'MockServices', status: 'error', error, txidResults: [{ txid, status: 'error' }] })
      }
    }
    return results
  }

  private async postOneTx (beef: Beef, txid: string): Promise<void> {
    const beefTx = beef.findTxid(txid)
    if (beefTx == null) throw new WERR_INVALID_PARAMETER('txid', `present in provided BEEF. txid: ${txid}`)
    const rawTx = beefTx.rawTx
    if (rawTx == null) throw new WERR_INVALID_PARAMETER('rawTx', `present in BEEF for txid: ${txid}`)

    const tx = BsvTransaction.fromBinary(rawTx)
    await this.validateTxInputs(tx)
    await this.populateMerklePaths(tx)

    const verified = await tx.verify('scripts only')
    if (!verified) throw new WERR_INVALID_PARAMETER('transaction', `pass script validation: ${verified}`)

    await this.storage.insertTransaction(txid, Array.from(rawTx))
    await this.storeOutputs(tx, txid)
    await this.spendInputs(tx, txid)
  }

  private async validateTxInputs (tx: BsvTransaction): Promise<void> {
    const currentHeight = await this.tracker.currentHeight()
    for (let i = 0; i < tx.inputs.length; i++) {
      const input = tx.inputs[i]
      const sourceTxid = input.sourceTXID || ((input.sourceTransaction != null) ? input.sourceTransaction.id('hex') : undefined)
      if (!sourceTxid) throw new WERR_INVALID_PARAMETER('input.sourceTXID', `defined for input ${i}`)

      const utxo = await this.storage.getUtxo(sourceTxid, input.sourceOutputIndex)
      if (utxo == null) throw new WERR_INVALID_PARAMETER('input', `reference a known UTXO. Input ${i}: ${sourceTxid}.${input.sourceOutputIndex} not found`)
      if (utxo.spentByTxid) throw new WERR_INVALID_PARAMETER('input', `not be already spent. Input ${i}: ${sourceTxid}.${input.sourceOutputIndex} spent by ${utxo.spentByTxid}`)
      if (utxo.isCoinbase && utxo.blockHeight !== null && currentHeight - utxo.blockHeight < 100) {
        throw new WERR_INVALID_PARAMETER('input', `not spend immature coinbase. Input ${i}: coinbase at height ${utxo.blockHeight}, current height ${currentHeight}, need 100 confirmations`)
      }

      if (input.sourceTransaction == null) {
        input.sourceTransaction = await this.loadSourceTransaction(sourceTxid)
      }
    }
  }

  private async loadSourceTransaction (sourceTxid: string): Promise<BsvTransaction | undefined> {
    const sourceTxRow = await this.storage.getTransaction(sourceTxid)
    if (sourceTxRow == null) return undefined
    const raw = sourceTxRow.rawTx instanceof Buffer
      ? Array.from(sourceTxRow.rawTx)
      : Array.isArray(sourceTxRow.rawTx) ? sourceTxRow.rawTx : Array.from(sourceTxRow.rawTx as Uint8Array)
    return BsvTransaction.fromBinary(raw)
  }

  private async populateMerklePaths (tx: BsvTransaction): Promise<void> {
    for (const input of tx.inputs) {
      if ((input.sourceTransaction == null) || (input.sourceTransaction.merklePath != null)) continue
      const stxid = input.sourceTransaction.id('hex')
      const stx = await this.storage.getTransaction(stxid)
      if ((stx == null) || stx.blockHeight === null) continue
      const txsInBlock = await this.storage.getTransactionsInBlock(stx.blockHeight)
      const stxids = txsInBlock.map(t => t.txid)
      const idx = stxids.indexOf(stxid)
      if (idx >= 0) input.sourceTransaction.merklePath = computeMerklePath(stxids, idx, stx.blockHeight)
    }
  }

  private async storeOutputs (tx: BsvTransaction, txid: string): Promise<void> {
    for (let vout = 0; vout < tx.outputs.length; vout++) {
      const output = tx.outputs[vout]
      const scriptBinary = output.lockingScript.toBinary()
      const scriptHash = asString(sha256Hash(Array.from(scriptBinary)))
      await this.storage.insertUtxo(txid, vout, Array.from(scriptBinary), output.satoshis ?? 0, scriptHash)
    }
  }

  private async spendInputs (tx: BsvTransaction, txid: string): Promise<void> {
    for (const input of tx.inputs) {
      const sourceTxid = input.sourceTXID || ((input.sourceTransaction != null) ? input.sourceTransaction.id('hex') : '')
      await this.storage.markUtxoSpent(sourceTxid, input.sourceOutputIndex, txid)
    }
  }

  async reorg (startingHeight: number, numBlocks: number, txidMap?: Record<string, number>): Promise<ReorgResult> {
    const oldTip = await this.storage.getChainTip()
    if (oldTip == null) throw new WERR_INTERNAL('Cannot reorg empty chain')
    if (startingHeight > oldTip.height) throw new WERR_INVALID_PARAMETER('startingHeight', `<= current tip height ${oldTip.height}`)

    const deactivatedHeaders: BlockHeader[] = []
    for (let h = startingHeight; h <= oldTip.height; h++) {
      const header = await this.storage.getBlockHeaderByHeight(h)
      if (header != null) deactivatedHeaders.push(header)
    }

    await this.knex.transaction(async trx => {
      const trxStorage = new MockChainStorage(trx as unknown as Knex)
      await this.tearDownOldBlocks(trxStorage, oldTip.height, startingHeight)
      await this.mineReorgBlocks(trxStorage, startingHeight, numBlocks, txidMap)
    })

    const newTip = await this.storage.getChainTip()
    if (newTip == null) throw new WERR_INTERNAL('Chain tip missing after reorg')
    return { oldTip, newTip, deactivatedHeaders }
  }

  private async tearDownOldBlocks (trxStorage: MockChainStorage, fromHeight: number, toHeight: number): Promise<void> {
    for (let h = fromHeight; h >= toHeight; h--) {
      const txsInBlock = await trxStorage.getTransactionsInBlock(h)
      const headerRow = await trxStorage.knex('mockchain_block_headers').where({ height: h }).first()
      const coinbaseTxid = headerRow?.coinbaseTxid

      for (const tx of txsInBlock) {
        if (coinbaseTxid && tx.txid === coinbaseTxid) {
          await trxStorage.deleteUtxosByTxid(tx.txid)
          await trxStorage.deleteTransaction(tx.txid)
        } else {
          await trxStorage.setTransactionBlock(tx.txid, null as any, null as any)
          await trxStorage.setUtxoBlockHeight(tx.txid, null)
        }
      }
      if (headerRow) await trxStorage.deleteBlockHeader(h)
    }
  }

  private async mineReorgBlocks (
    trxStorage: MockChainStorage,
    startingHeight: number,
    numBlocks: number,
    txidMap?: Record<string, number>
  ): Promise<void> {
    const { createCoinbaseTransaction } = await import('./MockMiner')
    const { computeMerkleRoot } = await import('./merkleTree')

    for (let i = 0; i < numBlocks; i++) {
      const newHeight = startingHeight + i
      const mappedTxids = txidMap != null ? Object.entries(txidMap).filter(([, o]) => o === i).map(([tid]) => tid) : []

      const prevHash = newHeight === 0
        ? '00'.repeat(32)
        : await this.getPrevHashForHeight(trxStorage, newHeight)

      const coinbaseTx = createCoinbaseTransaction(newHeight)
      const coinbaseTxid = coinbaseTx.id('hex')
      const coinbaseRawTx = Array.from(coinbaseTx.toBinary())
      const merkleRoot = computeMerkleRoot([coinbaseTxid, ...mappedTxids])

      const time = Math.floor(Date.now() / 1000)
      const bits = 0x207fffff
      const nonceBytes = Random(4)
      const nonce = ((nonceBytes[0] << 24) | (nonceBytes[1] << 16) | (nonceBytes[2] << 8) | nonceBytes[3]) >>> 0
      const hash = asString(doubleSha256BE(toBinaryBaseBlockHeader({ version: 1, previousHash: prevHash, merkleRoot, time, bits, nonce })))

      await trxStorage.knex('mockchain_transactions').insert({ txid: coinbaseTxid, rawTx: Buffer.from(coinbaseRawTx), blockHeight: newHeight, blockIndex: 0 })
      const coinbaseOutputScript = [0x51]
      await trxStorage.knex('mockchain_utxos').insert({ txid: coinbaseTxid, vout: 0, lockingScript: Buffer.from(coinbaseOutputScript), satoshis: 5_000_000_000, scriptHash: asString(sha256Hash(coinbaseOutputScript)), spentByTxid: null, isCoinbase: true, blockHeight: newHeight })

      for (let j = 0; j < mappedTxids.length; j++) {
        await trxStorage.setTransactionBlock(mappedTxids[j], newHeight, j + 1)
        await trxStorage.setUtxoBlockHeight(mappedTxids[j], newHeight)
      }
      await trxStorage.knex('mockchain_block_headers').insert({ height: newHeight, hash, previousHash: prevHash, merkleRoot, version: 1, time, bits, nonce, coinbaseTxid })
    }
  }

  private async getPrevHashForHeight (trxStorage: MockChainStorage, height: number): Promise<string> {
    const prevHeader = await trxStorage.getBlockHeaderByHeight(height - 1)
    if (prevHeader == null) throw new WERR_INTERNAL(`Missing block header at height ${height - 1}`)
    return prevHeader.hash
  }

  async getRawTx (txid: string): Promise<GetRawTxResult> {
    const tx = await this.storage.getTransaction(txid)
    if (tx == null) return { txid }
    let rawTx: number[]
    if (tx.rawTx instanceof Buffer) {
      rawTx = Array.from(tx.rawTx)
    } else if (Array.isArray(tx.rawTx)) {
      rawTx = tx.rawTx
    } else {
      rawTx = Array.from(tx.rawTx as Uint8Array)
    }
    return { txid, rawTx, name: 'MockServices' }
  }

  async getMerklePath (txid: string): Promise<GetMerklePathResult> {
    const tx = await this.storage.getTransaction(txid)
    if ((tx == null) || tx.blockHeight === null) return {}

    const txsInBlock = await this.storage.getTransactionsInBlock(tx.blockHeight)
    const txids = txsInBlock.map(t => t.txid)
    const targetIndex = txids.indexOf(txid)
    if (targetIndex < 0) return {}

    const header = await this.storage.getBlockHeaderByHeight(tx.blockHeight)

    const merklePath = computeMerklePath(txids, targetIndex, tx.blockHeight)
    return { merklePath, header: header || undefined, name: 'MockServices' }
  }

  async getUtxoStatus (
    output: string,
    outputFormat?: GetUtxoStatusOutputFormat,
    outpoint?: string
  ): Promise<GetUtxoStatusResult> {
    const hashBE = validateScriptHash(output, outputFormat)
    // Convert hashBE to hashLE for our storage (which stores hashLE)
    const hashLE = asString(asArray(hashBE).reverse())

    const utxos = await this.storage.getUtxosByScriptHash(hashLE)
    const unspent = utxos.filter(u => !u.spentByTxid)

    let isUtxo = unspent.length > 0
    const details = unspent.map(u => ({
      txid: u.txid,
      index: u.vout,
      height: u.blockHeight ?? undefined,
      satoshis: Number(u.satoshis)
    }))

    // If outpoint is provided, filter to match
    if (outpoint && isUtxo) {
      const [opTxid, opVoutStr] = outpoint.split('.')
      const opVout = Number.parseInt(opVoutStr, 10)
      const match = details.find(d => d.txid === opTxid && d.index === opVout)
      isUtxo = match != null
    }

    return {
      name: 'MockServices',
      status: 'success',
      isUtxo,
      details
    }
  }

  async getStatusForTxids (txids: string[]): Promise<GetStatusForTxidsResult> {
    const currentHeight = await this.tracker.currentHeight()
    const results = await Promise.all(
      txids.map(async txid => {
        const tx = await this.storage.getTransaction(txid)
        if (tx == null) return { txid, status: 'unknown' as const, depth: undefined }
        if (tx.blockHeight !== null) {
          const depth = currentHeight - tx.blockHeight + 1
          return { txid, status: 'mined' as const, depth }
        }
        return { txid, status: 'known' as const, depth: 0 }
      })
    )
    return { name: 'MockServices', status: 'success', results }
  }

  async getScriptHashHistory (hash: string): Promise<GetScriptHashHistoryResult> {
    const utxos = await this.storage.getUtxosByScriptHash(hash)
    const history = utxos.map(u => ({
      txid: u.txid,
      height: u.blockHeight ?? undefined
    }))
    return { name: 'MockServices', status: 'success', history }
  }

  async getChainTracker (): Promise<ChainTracker> {
    return this.tracker
  }

  async getHeaderForHeight (height: number): Promise<number[]> {
    const header = await this.storage.getBlockHeaderByHeight(height)
    if (header == null) throw new WERR_INVALID_PARAMETER('height', `valid height '${height}' on mock chain`)
    return toBinaryBaseBlockHeader(header)
  }

  async getHeight (): Promise<number> {
    return await this.tracker.currentHeight()
  }

  async hashToHeader (hash: string): Promise<BlockHeader> {
    const header = await this.storage.getBlockHeaderByHash(hash)
    if (header == null) throw new WERR_INVALID_PARAMETER('hash', `valid blockhash '${hash}' on mock chain`)
    return header
  }

  hashOutputScript (script: string): string {
    const hash = Utils.toHex(sha256Hash(Utils.toArray(script, 'hex')))
    return hash
  }

  async isUtxo (output: TableOutput): Promise<boolean> {
    if (output.lockingScript == null) {
      throw new WERR_INVALID_PARAMETER('output.lockingScript', 'validated by storage provider validateOutputScript.')
    }
    const hash = this.hashOutputScript(Utils.toHex(output.lockingScript))
    const or = await this.getUtxoStatus(hash, undefined, `${output.txid}.${output.vout}`)
    return or.isUtxo === true
  }

  async getBsvExchangeRate (): Promise<number> {
    return 50
  }

  async getFiatExchangeRate (currency: FiatCurrencyCode, base?: FiatCurrencyCode): Promise<number> {
    const baseCurrency = base ?? 'USD'
    return mockFiatRatesByUsd[currency] / mockFiatRatesByUsd[baseCurrency]
  }

  async getFiatExchangeRates (targetCurrencies: FiatCurrencyCode[]): Promise<FiatExchangeRates> {
    const rates: Record<string, number> = {}
    for (const c of targetCurrencies) rates[c] = mockFiatRatesByUsd[c]
    return {
      timestamp: new Date(),
      base: 'USD',
      rates
    }
  }

  async nLockTimeIsFinal (tx: string | number[] | BsvTransaction | number): Promise<boolean> {
    const MAXINT = 0xffffffff
    const BLOCK_LIMIT = 500000000

    let nLockTime: number

    if (typeof tx === 'number') nLockTime = tx
    else {
      if (typeof tx === 'string') {
        tx = BsvTransaction.fromHex(tx)
      } else if (Array.isArray(tx)) {
        tx = BsvTransaction.fromBinary(tx)
      }

      if (tx instanceof BsvTransaction) {
        if (tx.inputs.every(i => i.sequence === MAXINT)) return true
        nLockTime = tx.lockTime
      } else {
        throw new WERR_INTERNAL('Unsupported transaction format')
      }
    }

    if (nLockTime >= BLOCK_LIMIT) {
      const limit = Math.floor(Date.now() / 1000)
      return nLockTime < limit
    }

    const height = await this.getHeight()
    return nLockTime < height
  }

  async getBeefForTxid (txid: string): Promise<Beef> {
    const beef = new Beef()

    const addTx = async (tid: string, alreadyAdded: Set<string>) => {
      if (alreadyAdded.has(tid)) return
      alreadyAdded.add(tid)

      const txRow = await this.storage.getTransaction(tid)
      if (txRow == null) return

      let rawTx: number[]
      if (txRow.rawTx instanceof Buffer) {
        rawTx = Array.from(txRow.rawTx)
      } else if (Array.isArray(txRow.rawTx)) {
        rawTx = txRow.rawTx
      } else {
        rawTx = Array.from(txRow.rawTx as Uint8Array)
      }

      if (txRow.blockHeight !== null) {
        // Mined: add with merkle path
        const pathResult = await this.getMerklePath(tid)
        if (pathResult.merklePath != null) {
          const bumpIndex = beef.mergeBump(pathResult.merklePath)
          beef.mergeRawTx(rawTx, bumpIndex)
          return
        }
      }

      // Unmined or no path: recursively add source transactions
      const tx = BsvTransaction.fromBinary(rawTx)
      for (const input of tx.inputs) {
        const sourceTxid = input.sourceTXID || ((input.sourceTransaction != null) ? input.sourceTransaction.id('hex') : undefined)
        if (sourceTxid && sourceTxid !== '00'.repeat(32)) {
          await addTx(sourceTxid, alreadyAdded)
        }
      }
      beef.mergeRawTx(rawTx)
    }

    await addTx(txid, new Set())
    return beef
  }

  getServicesCallHistory (): ServicesCallHistory {
    return {
      version: 2,
      getMerklePath: { serviceName: 'getMerklePath', historyByProvider: {} },
      getRawTx: { serviceName: 'getRawTx', historyByProvider: {} },
      postBeef: { serviceName: 'postBeef', historyByProvider: {} },
      getUtxoStatus: { serviceName: 'getUtxoStatus', historyByProvider: {} },
      getStatusForTxids: { serviceName: 'getStatusForTxids', historyByProvider: {} },
      getScriptHashHistory: { serviceName: 'getScriptHashHistory', historyByProvider: {} },
      updateFiatExchangeRates: { serviceName: 'updateFiatExchangeRates', historyByProvider: {} }
    }
  }
}
