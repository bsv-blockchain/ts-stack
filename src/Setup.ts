import { Knex, knex as makeKnex } from 'knex'
import { KeyPairAddress, SetupWallet, SetupWalletClient } from './SetupWallet'
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
  Transaction,
  WalletInterface
} from '@bsv/sdk'
import { Chain } from './sdk/types'
import { randomBytesHex, verifyTruthy } from './utility/utilityHelpers'
import { WERR_INVALID_OPERATION } from './sdk/WERR_errors'
import { WalletStorageManager } from './storage/WalletStorageManager'
import { Services } from './services/Services'
import { Monitor } from './monitor/Monitor'
import { PrivilegedKeyManager } from './sdk/PrivilegedKeyManager'
import { Wallet } from './Wallet'
import { StorageClient } from './storage/remoting/StorageClient'
import { StorageKnex } from './storage/StorageKnex'
import { WalletStorageProvider } from './sdk/WalletStorage.interfaces'

// To rely on your own headers service, uncomment the following line:
// import { BHServiceClient } from './services/chaintracker'

import * as dotenv from 'dotenv'
dotenv.config()

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
export abstract class Setup {
  /**
   * @param chain
   * @returns true if .env is not valid for chain
   */
  static noEnv(chain: Chain): boolean {
    try {
      Setup.getEnv(chain)
      return false
    } catch {
      return true
    }
  }

  /**
   * Creates content for .env file with some private keys, identity keys, sample API keys, and sample MySQL connection string.
   *
   * Two new, random private keys are generated each time, with their associated public identity keys.
   *
   * Loading secrets from a .env file is intended only for experimentation and getting started.
   * Private keys should never be included directly in your source code.
   *
   * @publicbody
   */
  static makeEnv(): string {
    const testPrivKey1 = PrivateKey.fromRandom()
    const testIdentityKey1 = testPrivKey1.toPublicKey().toString()
    const testPrivKey2 = PrivateKey.fromRandom()
    const testIdentityKey2 = testPrivKey2.toPublicKey().toString()
    const mainPrivKey1 = PrivateKey.fromRandom()
    const mainIdentityKey1 = mainPrivKey1.toPublicKey().toString()
    const mainPrivKey2 = PrivateKey.fromRandom()
    const mainIdentityKey2 = mainPrivKey2.toPublicKey().toString()

    const log = `
# .env file template for working with wallet-toolbox Setup functions.
MY_TEST_IDENTITY = '${testIdentityKey1}'
MY_TEST_IDENTITY2 = '${testIdentityKey2}'
MY_MAIN_IDENTITY = '${mainIdentityKey1}'
MY_MAIN_IDENTITY2 = '${mainIdentityKey2}'
MAIN_TAAL_API_KEY='mainnet_9596de07e92300c6287e4393594ae39c'
TEST_TAAL_API_KEY='testnet_0e6cf72133b43ea2d7861da2a38684e3'
MYSQL_CONNECTION='{"port":3306,"host":"127.0.0.1","user":"root","password":"your_password","database":"your_database", "timezone": "Z"}'
DEV_KEYS = '{
    "${testIdentityKey1}": "${testPrivKey1.toString()}",
    "${testIdentityKey2}": "${testPrivKey2.toString()}",
    "${mainIdentityKey1}": "${mainPrivKey1.toString()}",
    "${mainIdentityKey2}": "${mainPrivKey2.toString()}"
}'
`
    console.log(log)

    return log
  }

  /**
   * Reads a .env file of the format created by `makeEnv`.
   *
   * Returns values for designated `chain`.
   *
   * Access private keys through the `devKeys` object: `devKeys[identityKey]`
   *
   * @param chain Which chain to use: 'test' or 'main'
   * @returns {SetupEnv} with configuration environment secrets used by `Setup` functions.
   *
   * @publicbody
   */
  static getEnv(chain: Chain): SetupEnv {
    // Identity keys of the lead maintainer of this repo...
    const identityKey = chain === 'main' ? process.env.MY_MAIN_IDENTITY : process.env.MY_TEST_IDENTITY
    const identityKey2 = chain === 'main' ? process.env.MY_MAIN_IDENTITY2 : process.env.MY_TEST_IDENTITY2
    const filePath = chain === 'main' ? process.env.MY_MAIN_FILEPATH : process.env.MY_TEST_FILEPATH
    const DEV_KEYS = process.env.DEV_KEYS || '{}'
    const mySQLConnection = process.env.MYSQL_CONNECTION || '{}'
    const taalApiKey = verifyTruthy(
      chain === 'main' ? process.env.MAIN_TAAL_API_KEY : process.env.TEST_TAAL_API_KEY,
      `.env value for '${chain.toUpperCase()}_TAAL_API_KEY' is required.`
    )

    if (!identityKey || !identityKey2) throw new WERR_INVALID_OPERATION('.env is not a valid SetupEnv configuration.')

    return {
      chain,
      identityKey,
      identityKey2,
      filePath,
      taalApiKey,
      devKeys: JSON.parse(DEV_KEYS) as Record<string, string>,
      mySQLConnection
    }
  }

  /**
   * Create a `Wallet`. Storage can optionally be provided or configured later.
   *
   * The following components are configured: KeyDeriver, WalletStorageManager, WalletService, WalletStorage.
   * Optionally, PrivilegedKeyManager is also configured.
   *
   * @publicbody
   */
  static async createWallet(args: SetupWalletArgs): Promise<SetupWallet> {
    const chain = args.env.chain
    args.rootKeyHex ||= args.env.devKeys[args.env.identityKey]
    const rootKey = PrivateKey.fromHex(args.rootKeyHex)
    const identityKey = rootKey.toPublicKey().toString()
    const keyDeriver = new CachedKeyDeriver(rootKey)
    const storage = new WalletStorageManager(identityKey, args.active, args.backups)
    if (storage.canMakeAvailable()) await storage.makeAvailable()
    const serviceOptions = Services.createDefaultOptions(chain)
    serviceOptions.taalApiKey = args.env.taalApiKey

    // To rely on your own headers service, uncomment the following line, updating the url and apiKey to your own values.
    // serviceOptions.chaintracks = new BHServiceClient('main', 'https://headers.spv.money', 'fC42F069YJs30FaWBAgikfDFEfIW1j4q')

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
  static async createWalletClient(args: SetupWalletClientArgs): Promise<SetupWalletClient> {
    const wo = await Setup.createWallet(args)

    const endpointUrl =
      args.endpointUrl || `https://${args.env.chain !== 'main' ? 'staging-' : ''}storage.babbage.systems`

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
    const lock = Setup.getLockP2PKH(Setup.getKeyPair(priv).address)
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
        lockingScript: Setup.getLockP2PKH(o.address).toHex(),
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
    const os = Setup.createP2PKHOutputs(outputs)

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
    const beefBin = inputBEEF ?? await Setup._buildBeefForOutpoints(outpoints)
    const beef = Beef.fromBinary(beefBin)
    const results: { outpoint: string; txid?: string; success: boolean; error?: string }[] = []
    for (let idx = 0; idx < parsed.length; idx++) {
      const { txid, vout } = parsed[idx]
      const outpoint = outpoints[idx]
      try {
        const resultTxid = await Setup._importSingleOutpoint(wallet, beef, beefBin, outpoint, txid, vout, p2pkhKey)
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
      return Setup._resolveAutoSigned(car, txid, vout)
    }
    return Setup._signAndComplete(wallet, car.signableTransaction, txid, vout, satoshis, p2pkhKey)
  }

  private static _resolveAutoSigned(
    car: { txid?: string; tx?: number[] },
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
    st: { tx: number[]; reference: string },
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
    unsignedTx.inputs[inputIndex].unlockingScriptTemplate = Setup.getUnlockP2PKH(p2pkhKey.privateKey, satoshis)
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
   * This solves the common case where legacy wallets (HandCash, ElectrumSV)
   * create chains of unconfirmed transactions — standard BEEF construction
   * fails because the proof chain is incomplete.
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
   * Adds `Knex` based storage to a `Wallet` configured by `Setup.createWalletOnly`
   *
   * @param args.knex `Knex` object configured for either MySQL or SQLite database access.
   * Schema will be created and migrated as needed.
   * For MySQL, a schema corresponding to databaseName must exist with full access permissions.
   * @param args.databaseName Name for this storage. For MySQL, the schema name within the MySQL instance.
   * @param args.chain Which chain this wallet is on: 'main' or 'test'. Defaults to 'test'.
   * @param args.rootKeyHex
   *
   * @publicbody
   */
  static async createWalletKnex(args: SetupWalletKnexArgs): Promise<SetupWalletKnex> {
    const wo = await Setup.createWallet(args)
    const activeStorage = await Setup.createStorageKnex(args)
    await wo.storage.addWalletStorageProvider(activeStorage)
    const { user, isNew } = await activeStorage.findOrInsertUser(wo.identityKey)
    const userId = user.userId
    const r: SetupWalletKnex = {
      ...wo,
      activeStorage,
      userId
    }
    return r
  }

  /**
   * @returns {StorageKnex} - `Knex` based storage provider for a wallet. May be used for either active storage or backup storage.
   */
  static async createStorageKnex(args: SetupWalletKnexArgs): Promise<StorageKnex> {
    // Create a temporary wallet setup to consistently resolve optional args.
    const wo = await Setup.createWallet(args)
    const storage = new StorageKnex({
      chain: wo.chain,
      knex: args.knex,
      commissionSatoshis: 0,
      commissionPubKeyHex: undefined,
      feeModel: { model: 'sat/kb', value: 1 }
    })
    await storage.migrate(args.databaseName, randomBytesHex(33))
    await storage.makeAvailable()
    await wo.wallet.destroy()
    return storage
  }

  /**
   * @publicbody
   */
  static createSQLiteKnex(filename: string): Knex {
    const config: Knex.Config = {
      client: 'better-sqlite3',
      connection: { filename },
      useNullAsDefault: true
    }
    const knex = makeKnex(config)
    return knex
  }

  /**
   * @publicbody
   */
  static createMySQLKnex(connection: string, database?: string): Knex {
    const c: Knex.MySql2ConnectionConfig = JSON.parse(connection)
    if (database) {
      c.database = database
    }
    const config: Knex.Config = {
      client: 'mysql2',
      connection: c,
      useNullAsDefault: true,
      pool: { min: 0, max: 7, idleTimeoutMillis: 15000 }
    }
    const knex = makeKnex(config)
    return knex
  }

  /**
   * @publicbody
   */
  static async createWalletMySQL(args: SetupWalletMySQLArgs): Promise<SetupWalletKnex> {
    return await this.createWalletKnex({
      ...args,
      knex: Setup.createMySQLKnex(args.env.mySQLConnection, args.databaseName)
    })
  }

  /**
   * @publicbody
   */
  static async createWalletSQLite(args: SetupWalletSQLiteArgs): Promise<SetupWalletKnex> {
    return await this.createWalletKnex({
      ...args,
      knex: Setup.createSQLiteKnex(args.filePath)
    })
  }
}

/**
 * Arguments used by `createWallet` to construct a `SetupWallet`.
 *
 * Extension `SetupWalletClientArgs` used by `createWalletClient` to construct a `SetupWalletClient`.
 *
 * Extension `SetupWalletKnexArgs` used by `createWalletKnex` to construct a `SetupWalletKnex`.
 *
 * Extension `SetupWalletMySQLArgs` used by `createWalletMySQL` to construct a `SetupWalletKnex`.
 *
 * Extension `SetupWalletSQLiteArgs` used by `createWalletSQLite` to construct a `SetupWalletKnex`.
 */
export interface SetupWalletArgs {
  /**
   * Configuration "secrets" typically obtained by `Setup.makeEnv` and `Setup.getEnv` functions.
   */
  env: SetupEnv
  /**
   * Optional. The non-privileged private key used to initialize the `KeyDeriver` and determine the `identityKey`.
   * Defaults to `env.devKeys[env.identityKey]
   */
  rootKeyHex?: string
  /**
   * Optional. The privileged private key getter used to initialize the `PrivilegedKeyManager`.
   * Defaults to undefined.
   */
  privilegedKeyGetter?: () => Promise<PrivateKey>
  /**
   * Optional. Active wallet storage. Can be added later.
   */
  active?: WalletStorageProvider
  /**
   * Optional. One or more storage providers managed as backup destinations. Can be added later.
   */
  backups?: WalletStorageProvider[]
}

/**
 *
 */
export interface SetupWalletKnexArgs extends SetupWalletArgs {
  knex: Knex<any, any[]>
  databaseName: string
}

/**
 *
 */
export interface SetupWalletMySQLArgs extends SetupWalletArgs {
  databaseName: string
}

/**
 *
 */
export interface SetupWalletSQLiteArgs extends SetupWalletArgs {
  filePath: string
  databaseName: string
}

/**
 *
 */
export interface SetupWalletKnex extends SetupWallet {
  activeStorage: StorageKnex
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
 * `SetupEnv` provides a starting point for managing secrets that
 * must not appear in source code.
 *
 * The `makeEnv` and `getEnv` functions of the `Setup` and `SetupClient` classes
 * provide an easy way to create and import these secrets and related properties.
 */
export interface SetupEnv {
  /**
   * The chan being accessed: 'main' for mainnet, 'test' for 'testnet'.
   */
  chain: Chain
  /**
   * The user's primary identity key (public key).
   */
  identityKey: string
  /**
   * A secondary identity key (public key), used to test exchanges with other users.
   */
  identityKey2: string
  /**
   * Filepath to sqlite file to be used for identityKey wallet.
   */
  filePath: string | undefined
  /**
   * A vaild TAAL API key for use by `Services`
   */
  taalApiKey: string
  /**
   * A map of public keys (identity keys, hex strings) to private keys (hex strings).
   */
  devKeys: Record<string, string>
  /**
   * A MySQL connection string including user and password properties.
   * Must be valid to make use of MySQL `Setup` class support.
   */
  mySQLConnection: string
}

/**
 * Extension `SetupWalletClientArgs` of `SetupWalletArgs` is used by `createWalletClient`
 * to construct a `SetupWalletClient`.
 */
export interface SetupWalletClientArgs extends SetupWalletArgs {
  /**
   * The endpoint URL of a service hosting the `StorageServer` JSON-RPC service to
   * which a `StorageClient` instance should connect to function as
   * the active storage provider of the newly created wallet.
   */
  endpointUrl?: string
}
