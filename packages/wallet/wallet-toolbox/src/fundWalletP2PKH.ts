/**
 * Shared helpers for fundWalletFromP2PKHOutpoints.
 * Used by both Setup (Node) and SetupClient (browser/isomorphic).
 */
import {
  Beef,
  BEEF,
  CreateActionResult,
  LockingScript,
  MerklePath,
  PublicKey,
  ScriptTemplateUnlock,
  SignableTransaction,
  Transaction,
  WalletInterface
} from '@bsv/sdk'
import { KeyPairAddress } from './SetupWallet'

export interface ParsedOutpoint {
  outpoint: string
  txid: string
  vout: number
}

/** Strictly parse an outpoint string into txid and vout components. */
export function parseOutpoint(s: string): ParsedOutpoint {
  const m = /^([0-9a-fA-F]{64})\.(\d+)$/.exec(s)
  if (!m) throw new Error(`Invalid outpoint format: ${s}`)
  const txid = m[1].toLowerCase()
  const vout = Number(m[2])
  if (!Number.isSafeInteger(vout) || vout < 0) throw new Error(`Invalid vout in outpoint: ${s}`)
  return { outpoint: s, txid, vout }
}

/** Parse raw hex into a Transaction and assert its hash matches the expected txid. */
export function parseTxAndAssertId(rawHex: string, expectedTxid: string): Transaction {
  const tx = Transaction.fromHex(rawHex)
  const got = tx.id('hex')
  if (got.toLowerCase() !== expectedTxid.toLowerCase()) {
    throw new Error(`Fetched tx hex txid mismatch: expected=${expectedTxid} got=${got}`)
  }
  return tx
}

/** Verify that a locking script is standard P2PKH and its hash160 matches the given public key. */
export function verifyP2PKHOwnership(lockingScript: LockingScript, publicKey: PublicKey): void {
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

/** @internal */
export function resolveAutoSigned(car: CreateActionResult, txid: string, vout: number): string {
  if (!car.txid || !/^[0-9a-f]{64}$/i.test(car.txid)) {
    throw new Error('createAction returned no signableTransaction and no valid txid')
  }
  if (car.tx) {
    const completedTx = Transaction.fromAtomicBEEF(car.tx)
    if (completedTx.id('hex').toLowerCase() !== car.txid.toLowerCase()) {
      throw new Error('Auto-signed tx id mismatch with car.txid')
    }
    if (
      !completedTx.inputs.some(inp => String(inp.sourceTXID).toLowerCase() === txid && inp.sourceOutputIndex === vout)
    ) {
      throw new Error('Auto-signed tx does not spend the requested outpoint')
    }
  }
  return car.txid
}

/** @internal */
export async function signAndComplete(
  wallet: WalletInterface,
  st: SignableTransaction,
  txid: string,
  vout: number,
  satoshis: number,
  p2pkhKey: KeyPairAddress,
  getUnlockP2PKH: (priv: KeyPairAddress['privateKey'], satoshis: number) => ScriptTemplateUnlock
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
  unsignedTx.inputs[inputIndex].unlockingScriptTemplate = getUnlockP2PKH(p2pkhKey.privateKey, satoshis)
  await unsignedTx.sign()
  const unlockingScript = unsignedTx.inputs[inputIndex].unlockingScript!.toHex()
  const sar = await wallet.signAction({ reference: st.reference, spends: { [inputIndex]: { unlockingScript } } })
  if (!sar.txid || !/^[0-9a-f]{64}$/i.test(sar.txid)) throw new Error('signAction returned no valid txid')
  return sar.txid
}

/** @internal */
export async function importSingleOutpoint(
  wallet: WalletInterface,
  beef: Beef,
  beefBin: BEEF,
  parsed: ParsedOutpoint,
  p2pkhKey: KeyPairAddress,
  getUnlockP2PKH: (priv: KeyPairAddress['privateKey'], satoshis: number) => ScriptTemplateUnlock
): Promise<string> {
  const { outpoint, txid, vout } = parsed
  const btx = beef.findTxid(txid)
  if (!btx?.tx) throw new Error(`Transaction ${txid} not found in inputBEEF`)
  if (vout < 0 || vout >= btx.tx.outputs.length)
    throw new Error(`vout ${vout} out of range (tx has ${btx.tx.outputs.length} outputs)`)
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
    return resolveAutoSigned(car, txid, vout)
  }
  return signAndComplete(wallet, car.signableTransaction, txid, vout, satoshis, p2pkhKey, getUnlockP2PKH)
}

/**
 * Funds a BRC-100 wallet by importing P2PKH UTXOs.
 *
 * Accepts outpoints + a P2PKH key pair, optionally with a pre-built BEEF.
 * If no BEEF is provided, one is built via buildBeefForOutpoints.
 */
export async function fundWalletFromP2PKHOutpoints(
  wallet: WalletInterface,
  outpoints: string[],
  p2pkhKey: KeyPairAddress,
  getUnlockP2PKH: (priv: KeyPairAddress['privateKey'], satoshis: number) => ScriptTemplateUnlock,
  inputBEEF?: BEEF
): Promise<{ outpoint: string; txid?: string; success: boolean; error?: string }[]> {
  const parsed = outpoints.map(o => parseOutpoint(o))
  const seen = new Set<string>()
  for (const p of parsed) {
    const key = `${p.txid}.${p.vout}`
    if (seen.has(key)) throw new Error(`Duplicate outpoint: ${key}`)
    seen.add(key)
  }
  const beefBin = inputBEEF ?? (await buildBeefForOutpoints(outpoints))
  const beef = Beef.fromBinary(beefBin)
  const results: { outpoint: string; txid?: string; success: boolean; error?: string }[] = []
  for (const p of parsed) {
    try {
      const resultTxid = await importSingleOutpoint(wallet, beef, beefBin, p, p2pkhKey, getUnlockP2PKH)
      results.push({ outpoint: p.outpoint, txid: resultTxid, success: true })
    } catch (err: unknown) {
      results.push({ outpoint: p.outpoint, success: false, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return results
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
export async function buildBeefForOutpoints(outpoints: string[], maxDepth = 10): Promise<BEEF> {
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
      } catch {
        /* try next */
      }
    }
    return null
  }

  async function fetchMerklePath(txid: string): Promise<MerklePath | null> {
    try {
      const ctrl = new AbortController()
      const t = setTimeout(() => ctrl.abort(), 8000)
      const res = await fetch(`https://ordinals.gorillapool.io/api/tx/${txid}/proof`, { signal: ctrl.signal })
      clearTimeout(t)
      if (!res.ok) return null
      const buf = new Uint8Array(await res.arrayBuffer())
      return MerklePath.fromBinary(Array.from(buf))
    } catch {
      return null
    }
  }

  async function addTxToBeef(txid: string, depth: number): Promise<void> {
    if (fetched.has(txid)) return
    if (depth > maxDepth) {
      throw new Error(`BEEF build exceeded maxDepth=${maxDepth} while resolving ${txid}`)
    }
    fetched.add(txid)

    const rawHex = await fetchRawTx(txid)
    if (!rawHex) throw new Error(`Failed to fetch raw transaction ${txid} from any provider`)

    const tx = parseTxAndAssertId(rawHex, txid)
    const merklePath = await fetchMerklePath(txid)

    if (merklePath) {
      tx.merklePath = merklePath
    } else {
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
