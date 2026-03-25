import {
  Beef,
  BEEF,
  CachedKeyDeriver,
  CreateActionArgs,
  CreateActionOptions,
  CreateActionOutput,
  CreateActionResult,
  KeyDeriver,
  KeyDeriverApi,
  LockingScript,
  MerklePath,
  P2PKH,
  PrivateKey,
  PublicKey,
  ScriptTemplateUnlock,
  SignableTransaction,
  Transaction,
  WalletInterface
} from '@bsv/sdk'
import { KeyPairAddress, SetupClientWalletArgs, SetupWallet, SetupWalletClient } from './SetupWallet'
import { StorageIdb } from './storage/StorageIdb'
import { WalletStorageManager } from './storage/WalletStorageManager'
import { Services } from './services/Services'
import { Monitor } from './monitor/Monitor'
import { PrivilegedKeyManager } from './sdk/PrivilegedKeyManager'
import { Wallet } from './Wallet'
import { Chain } from './sdk/types'
import { randomBytesHex } from './utility/utilityHelpers'
import { StorageClient } from './storage/remoting/StorageClient'

/** Strictly parse an outpoint string into txid and vout components. */
function parseOutpoint(s: string): { txid: string; vout: number } {
  const m = /^([0-9a-fA-F]{64})\.(\d+)$/.exec(s)
  if (!m) throw new Error(`Invalid outpoint format: ${s}`)
  const txid = m[1].toLowerCase()
  const vout = Number(m[2])
  if (!Number.isSafeInteger(vout) || vout < 0) throw new Error(`Invalid vout in outpoint: ${s}`)
  return { txid, vout }
}

/** Parse raw hex into a Transaction and assert its hash matches the expected txid. */
function parseTxAndAssertId(rawHex: string, expectedTxid: string): Transaction {
  const tx = Transaction.fromHex(rawHex)
  const got = tx.id('hex')
  if (got.toLowerCase() !== expectedTxid.toLowerCase()) {
    throw new Error(`Fetched tx hex txid mismatch: expected=${expectedTxid} got=${got}`)
  }
  return tx
}

/** Verify that a locking script is standard P2PKH and its hash160 matches the given public key. */
function verifyP2PKHOwnership(lockingScript: LockingScript, publicKey: PublicKey): void {
  const chunks = lockingScript.chunks
  if (chunks.length !== 5) throw new Error('UTXO is not standard P2PKH')
  if (chunks[0].op !== 118) throw new Error('UTXO is not P2PKH (missing OP_DUP)')
  if (chunks[1].op !== 169) throw new Error('UTXO is not P2PKH (missing OP_HASH160)')
  if (chunks[2].data?.length !== 20) throw new Error('UTXO is not P2PKH (bad hash160)')
  if (chunks[3].op !== 136) throw new Error('UTXO is not P2PKH (missing OP_EQUALVERIFY)')
  if (chunks[4].op !== 172) throw new Error('UTXO is not P2PKH (missing OP_CHECKSIG)')

  const scriptHash = chunks[2].data!
  const keyHash = publicKey.toHash() as number[]
  if (scriptHash.length !== keyHash.length) throw new Error('P2PKH hash160 length mismatch')
  for (let i = 0; i < scriptHash.length; i++) {
    if (scriptHash[i] !== keyHash[i]) throw new Error('UTXO P2PKH hash160 does not match provided key')
  }
}

/**
 * The 'Setup` class provides static setup functions to construct BRC-100 compatible
 * wallets in a variety of configurations.
 *
 * It serves as a starting point for experimentation and customization.
 */
export abstract class SetupClient {
  /**
   * Create a `Wallet`. Storage can optionally be provided or configured later.
   *
   * The following components are configured: KeyDeriver, WalletStorageManager, WalletService, WalletStorage.
   * Optionally, PrivilegedKeyManager is also configured.
   *
   * @publicbody
   */
  static async createWallet(args: SetupClientWalletArgs): Promise<SetupWallet> {
    const chain = args.chain
    const rootKey = PrivateKey.fromHex(args.rootKeyHex)
    const identityKey = rootKey.toPublicKey().toString()
    const keyDeriver = new CachedKeyDeriver(rootKey)
    const storage = new WalletStorageManager(identityKey, args.active, args.backups)
    if (storage.canMakeAvailable()) await storage.makeAvailable()
    const serviceOptions = Services.createDefaultOptions(chain)
    serviceOptions.taalApiKey = args.taalApiKey
    const services = new Services(serviceOptions)
    const monopts = Monitor.createDefaultWalletMonitorOptions(chain, storage, services)
    const monitor = new Monitor(monopts)
    monitor.addDefaultTasks()
    const privilegedKeyManager = args.privilegedKeyGetter
      ? new PrivilegedKeyManager(args.privilegedKeyGetter)
      : undefined
    const wallet = new Wallet({
      chain,
      keyDeriver,
      storage,
      services,
      monitor,
      privilegedKeyManager
    })
    const r: SetupWallet = {
      rootKey,
      identityKey,
      keyDeriver,
      chain,
      storage,
      services,
      monitor,
      wallet
    }
    return r
  }

  /**
   * Setup a new `Wallet` without requiring a .env file.
   *
   * @param args.chain - 'main' or 'test'
   * @param args.rootKeyHex  - Root private key for wallet's key deriver.
   * @param args.storageUrl - Optional. `StorageClient` and `chain` compatible endpoint URL.
   * @param args.privilegedKeyGetter - Optional. Method that will return the privileged `PrivateKey`, on demand.
   */
  static async createWalletClientNoEnv(args: {
    chain: Chain
    rootKeyHex: string
    storageUrl?: string
    privilegedKeyGetter?: () => Promise<PrivateKey>
  }): Promise<Wallet> {
    const chain = args.chain
    const endpointUrl = args.storageUrl || `https://${args.chain !== 'main' ? 'staging-' : ''}storage.babbage.systems`
    const rootKey = PrivateKey.fromHex(args.rootKeyHex)
    const keyDeriver = new CachedKeyDeriver(rootKey)
    const storage = new WalletStorageManager(keyDeriver.identityKey)
    const services = new Services(chain)
    const privilegedKeyManager = args.privilegedKeyGetter
      ? new PrivilegedKeyManager(args.privilegedKeyGetter)
      : undefined
    const wallet = new Wallet({
      chain,
      keyDeriver,
      storage,
      services,
      privilegedKeyManager
    })
    const client = new StorageClient(wallet, endpointUrl)
    await storage.addWalletStorageProvider(client)
    await storage.makeAvailable()
    return wallet
  }

  /**
   * @publicbody
   */
  static async createWalletClient(args: SetupClientWalletClientArgs): Promise<SetupWalletClient> {
    const wo = await SetupClient.createWallet(args)

    const endpointUrl = args.endpointUrl || `https://${args.chain !== 'main' ? 'staging-' : ''}storage.babbage.systems`

    const client = new StorageClient(wo.wallet, endpointUrl)
    await wo.storage.addWalletStorageProvider(client)
    await wo.storage.makeAvailable()
    return {
      ...wo,
      endpointUrl
    }
  }

  /**
   * @publicbody
   */
  static getKeyPair(priv?: string | PrivateKey): KeyPairAddress {
    if (priv === undefined) priv = PrivateKey.fromRandom()
    else if (typeof priv === 'string') priv = new PrivateKey(priv, 'hex')

    const pub = PublicKey.fromPrivateKey(priv)
    const address = pub.toAddress()
    return { privateKey: priv, publicKey: pub, address }
  }

  /**
   * @publicbody
   */
  static getLockP2PKH(address: string): LockingScript {
    const p2pkh = new P2PKH()
    const lock = p2pkh.lock(address)
    return lock
  }

  /**
   * @publicbody
   */
  static getUnlockP2PKH(priv: PrivateKey, satoshis: number): ScriptTemplateUnlock {
    const p2pkh = new P2PKH()
    const lock = SetupClient.getLockP2PKH(SetupClient.getKeyPair(priv).address)
    // Prepare to pay with SIGHASH_ALL and without ANYONE_CAN_PAY.
    // In otherwords:
    // - all outputs must remain in the current order, amount and locking scripts.
    // - all inputs must remain from the current outpoints and sequence numbers.
    // (unlock scripts are never signed)
    const unlock = p2pkh.unlock(priv, 'all', false, satoshis, lock)
    return unlock
  }

  /**
   * @publicbody
   */
  static createP2PKHOutputs(
    outputs: {
      address: string
      satoshis: number
      outputDescription?: string
      basket?: string
      tags?: string[]
    }[]
  ): CreateActionOutput[] {
    const os: CreateActionOutput[] = []
    const count = outputs.length
    for (let i = 0; i < count; i++) {
      const o = outputs[i]
      os.push({
        basket: o.basket,
        tags: o.tags,
        satoshis: o.satoshis,
        lockingScript: SetupClient.getLockP2PKH(o.address).toHex(),
        outputDescription: o.outputDescription || `p2pkh ${i}`
      })
    }
    return os
  }

  /**
   * @publicbody
   */
  static async createP2PKHOutputsAction(
    wallet: WalletInterface,
    outputs: {
      address: string
      satoshis: number
      outputDescription?: string
      basket?: string
      tags?: string[]
    }[],
    options?: CreateActionOptions
  ): Promise<{
    cr: CreateActionResult
    outpoints: string[] | undefined
  }> {
    const os = SetupClient.createP2PKHOutputs(outputs)

    const createArgs: CreateActionArgs = {
      description: `createP2PKHOutputs`,
      outputs: os,
      options: {
        ...options,
        // Don't randomize so we can simplify outpoint creation
        randomizeOutputs: false
      }
    }

    const cr = await wallet.createAction(createArgs)

    let outpoints: string[] | undefined

    if (cr.txid) {
      outpoints = os.map((o, i) => `${cr.txid}.${i}`)
    }

    return { cr, outpoints }
  }

  /**
   * @publicbody
   */
  static async fundWalletFromP2PKHOutpoints(
    wallet: WalletInterface,
    outpoints: string[],
    p2pkhKey: KeyPairAddress,
    inputBEEF?: BEEF
  ): Promise<{ outpoint: string; txid?: string; success: boolean; error?: string }[]> {
    const parsed = outpoints.map(o => parseOutpoint(o))
    const seen = new Set<string>()
    for (const p of parsed) {
      const key = `${p.txid}.${p.vout}`
      if (seen.has(key)) throw new Error(`Duplicate outpoint: ${key}`)
      seen.add(key)
    }
    const beefBin = inputBEEF ?? await SetupClient._buildBeefForOutpoints(outpoints)
    const beef = Beef.fromBinary(beefBin)
    const results: { outpoint: string; txid?: string; success: boolean; error?: string }[] = []
    for (let idx = 0; idx < parsed.length; idx++) {
      const { txid, vout } = parsed[idx]
      const outpoint = outpoints[idx]
      try {
        const resultTxid = await SetupClient._importSingleOutpoint(wallet, beef, beefBin, outpoint, txid, vout, p2pkhKey)
        results.push({ outpoint, txid: resultTxid, success: true })
      } catch (err: unknown) {
        results.push({ outpoint, success: false, error: err instanceof Error ? err.message : String(err) })
      }
    }
    return results
  }

  private static async _importSingleOutpoint(
    wallet: WalletInterface,
    beef: Beef,
    beefBin: BEEF,
    outpoint: string,
    txid: string,
    vout: number,
    p2pkhKey: KeyPairAddress
  ): Promise<string> {
    const btx = beef.findTxid(txid)
    if (!btx?.tx) throw new Error(`Transaction ${txid} not found in inputBEEF`)
    if (vout < 0 || vout >= btx.tx.outputs.length) throw new Error(`vout ${vout} out of range (tx has ${btx.tx.outputs.length} outputs)`)
    const output = btx.tx.outputs[vout]
    const satoshis = output.satoshis
    if (!satoshis || satoshis <= 0) throw new Error(`Output ${outpoint} has no satoshis`)
    verifyP2PKHOwnership(output.lockingScript, p2pkhKey.publicKey)
    const car = await wallet.createAction({
      inputBEEF: beefBin,
      inputs: [{ outpoint, unlockingScriptLength: 108, inputDescription: 'fund wallet from P2PKH' }],
      labels: ['p2pkh-funding'],
      description: `Import P2PKH UTXO ${txid.slice(0, 16)}...`,
      options: { trustSelf: 'known' }
    })
    if (!car.signableTransaction) {
      return SetupClient._resolveAutoSigned(car, txid, vout)
    }
    return SetupClient._signAndComplete(wallet, car.signableTransaction, txid, vout, satoshis, p2pkhKey)
  }

  private static _resolveAutoSigned(
    car: CreateActionResult,
    txid: string,
    vout: number
  ): string {
    if (!car.txid || !/^[0-9a-f]{64}$/i.test(car.txid)) {
      throw new Error('createAction returned no signableTransaction and no valid txid')
    }
    if (car.tx) {
      const completedTx = Transaction.fromAtomicBEEF(car.tx)
      if (completedTx.id('hex').toLowerCase() !== car.txid.toLowerCase()) {
        throw new Error('Auto-signed tx id mismatch with car.txid')
      }
      if (!completedTx.inputs.some(inp => String(inp.sourceTXID).toLowerCase() === txid && inp.sourceOutputIndex === vout)) {
        throw new Error('Auto-signed tx does not spend the requested outpoint')
      }
    }
    return car.txid
  }

  private static async _signAndComplete(
    wallet: WalletInterface,
    st: SignableTransaction,
    txid: string,
    vout: number,
    satoshis: number,
    p2pkhKey: KeyPairAddress
  ): Promise<string> {
    const stBeef = Beef.fromBinary(st.tx)
    let unsignedTx: Transaction | undefined
    let inputIndex = -1
    for (const stbtx of stBeef.txs) {
      if (!stbtx.tx) continue
      for (let i = 0; i < stbtx.tx.inputs.length; i++) {
        const inp = stbtx.tx.inputs[i]
        if (String(inp.sourceTXID).toLowerCase() === txid && inp.sourceOutputIndex === vout) {
          unsignedTx = stbtx.tx
          inputIndex = i
          break
        }
      }
      if (unsignedTx) break
    }
    if (!unsignedTx || inputIndex < 0) throw new Error('Could not find requested outpoint in signable transaction inputs')
    unsignedTx.inputs[inputIndex].unlockingScriptTemplate = SetupClient.getUnlockP2PKH(p2pkhKey.privateKey, satoshis)
    await unsignedTx.sign()
    const unlockingScript = unsignedTx.inputs[inputIndex].unlockingScript!.toHex()
    const sar = await wallet.signAction({ reference: st.reference, spends: { [inputIndex]: { unlockingScript } } })
    if (!sar.txid || !/^[0-9a-f]{64}$/i.test(sar.txid)) throw new Error('signAction returned no valid txid')
    return sar.txid
  }

  /**
   * Builds a valid BEEF for the given outpoints by recursively fetching
   * parent transactions until all paths lead to confirmed ancestors
   * with merkle proofs.
   *
   * @internal
   */
  private static async _buildBeefForOutpoints(outpoints: string[], maxDepth = 10): Promise<BEEF> {
    const beef = new Beef()
    const fetched = new Set<string>()

    async function fetchRawTx(txid: string): Promise<string | null> {
      const providers = [
        `https://ordinals.gorillapool.io/api/tx/${txid}/hex`,
        `https://api.whatsonchain.com/v1/bsv/main/tx/${txid}/hex`
      ]
      for (const url of providers) {
        try {
          const ctrl = new AbortController()
          const t = setTimeout(() => ctrl.abort(), 8000)
          const res = await fetch(url, { signal: ctrl.signal })
          clearTimeout(t)
          if (res.ok) return (await res.text()).trim()
        } catch { /* try next */ }
      }
      return null
    }

    async function fetchMerklePath(txid: string): Promise<MerklePath | null> {
      try {
        const ctrl = new AbortController()
        const t = setTimeout(() => ctrl.abort(), 8000)
        const res = await fetch(
          `https://ordinals.gorillapool.io/api/tx/${txid}/proof`,
          { signal: ctrl.signal }
        )
        clearTimeout(t)
        if (!res.ok) return null
        const buf = new Uint8Array(await res.arrayBuffer())
        return MerklePath.fromBinary(Array.from(buf))
      } catch { return null }
    }

    async function addTxToBeef(txid: string, depth: number): Promise<void> {
      if (fetched.has(txid)) return
      if (depth > maxDepth) {
        throw new Error(`BEEF build exceeded maxDepth=${maxDepth} while resolving ${txid}`)
      }
      fetched.add(txid)

      const rawHex = await fetchRawTx(txid)
      if (!rawHex) throw new Error(`Failed to fetch raw transaction ${txid} from any provider`)

      // Verify fetched tx hashes to requested txid
      const tx = parseTxAndAssertId(rawHex, txid)
      const merklePath = await fetchMerklePath(txid)

      if (merklePath) {
        tx.merklePath = merklePath
      } else {
        // Unconfirmed — chase parent transactions (parents merge before child)
        for (const input of tx.inputs) {
          if (input.sourceTXID) {
            await addTxToBeef(input.sourceTXID, depth + 1)
          }
        }
      }

      beef.mergeTransaction(tx)
    }

    for (const outpoint of outpoints) {
      const { txid } = parseOutpoint(outpoint)
      await addTxToBeef(txid, 0)
    }

    return beef.toBinary()
  }

  /**
   * Adds `indexedDB` based storage to a `Wallet` configured by `SetupClient.createWalletOnly`
   *
   * @param args.databaseName Name for this storage. For MySQL, the schema name within the MySQL instance.
   * @param args.chain Which chain this wallet is on: 'main' or 'test'. Defaults to 'test'.
   * @param args.rootKeyHex
   *
   * @publicbody
   */
  static async createWalletIdb(args: SetupWalletIdbArgs): Promise<SetupWalletIdb> {
    const wo = await SetupClient.createWallet(args)
    const activeStorage = await SetupClient.createStorageIdb(args)
    await wo.storage.addWalletStorageProvider(activeStorage)
    const { user, isNew } = await activeStorage.findOrInsertUser(wo.identityKey)
    const userId = user.userId
    const r: SetupWalletIdb = {
      ...wo,
      activeStorage,
      userId
    }
    return r
  }

  /**
   * @returns {StorageIdb} - `Knex` based storage provider for a wallet. May be used for either active storage or backup storage.
   */
  static async createStorageIdb(args: SetupWalletIdbArgs): Promise<StorageIdb> {
    const storage = new StorageIdb({
      chain: args.chain,
      commissionSatoshis: 0,
      commissionPubKeyHex: undefined,
      feeModel: { model: 'sat/kb', value: 1 }
    })
    await storage.migrate(args.databaseName, randomBytesHex(33))
    await storage.makeAvailable()
    return storage
  }
}

/**
 *
 */
export interface SetupWalletIdbArgs extends SetupClientWalletArgs {
  databaseName: string
}

/**
 *
 */
export interface SetupWalletIdb extends SetupWallet {
  activeStorage: StorageIdb
  userId: number

  rootKey: PrivateKey
  identityKey: string
  keyDeriver: KeyDeriverApi
  chain: Chain
  storage: WalletStorageManager
  services: Services
  monitor: Monitor
  wallet: Wallet
}

/**
 * Extension `SetupWalletClientArgs` of `SetupWalletArgs` is used by `createWalletClient`
 * to construct a `SetupWalletClient`.
 */
export interface SetupClientWalletClientArgs extends SetupClientWalletArgs {
  /**
   * The endpoint URL of a service hosting the `StorageServer` JSON-RPC service to
   * which a `StorageClient` instance should connect to function as
   * the active storage provider of the newly created wallet.
   */
  endpointUrl?: string
}
