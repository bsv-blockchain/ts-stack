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

const MAX_OUTPOINTS = 256
const MAX_BEEF_TRANSACTIONS = 4096
const MAX_BEEF_SOURCE_BYTES = 64 * 1024 * 1024
const MAX_RAW_TX_HEX_BYTES = 32 * 1024 * 1024
const MAX_MERKLE_PATH_BYTES = 4 * 1024 * 1024
const FETCH_TIMEOUT_MS = 8000

class FundingResourceLimitError extends Error {}

async function readBoundedResponse(
  response: Response,
  maximumBytes: number,
  label: string
): Promise<Uint8Array> {
  const declared = response.headers.get('content-length')
  if (declared != null) {
    if (!/^\d+$/.test(declared)) throw new Error(`${label} returned an invalid Content-Length`)
    const length = Number(declared)
    if (!Number.isSafeInteger(length) || length > maximumBytes) {
      await response.body?.cancel().catch(() => undefined)
      throw new FundingResourceLimitError(`${label} exceeds ${maximumBytes} bytes`)
    }
  }
  if (response.body == null) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.length
      if (length > maximumBytes) {
        await reader.cancel().catch(() => undefined)
        throw new FundingResourceLimitError(`${label} exceeds ${maximumBytes} bytes`)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  return bytes
}

async function fetchBounded(url: string, maximumBytes: number, label: string): Promise<Uint8Array> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'error',
      signal: controller.signal
    })
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      throw new Error(`${label} returned HTTP ${response.status}`)
    }
    return await readBoundedResponse(response, maximumBytes, label)
  } finally {
    clearTimeout(timeout)
  }
}

/** Strictly parse an outpoint string into txid and vout components. */
export function parseOutpoint (s: string): ParsedOutpoint {
  if (typeof s !== 'string') throw new TypeError('Outpoint must be a string')
  const m = /^([0-9a-fA-F]{64})\.(\d+)$/.exec(s)
  if (m == null) throw new Error(`Invalid outpoint format: ${s}`)
  const txid = m[1].toLowerCase()
  const vout = Number(m[2])
  if (!Number.isSafeInteger(vout) || vout < 0 || vout > 0xffffffff) {
    throw new Error(`Invalid vout in outpoint: ${s}`)
  }
  return { outpoint: s, txid, vout }
}

/** Parse raw hex into a Transaction and assert its hash matches the expected txid. */
export function parseTxAndAssertId (rawHex: string, expectedTxid: string): Transaction {
  if (typeof rawHex !== 'string' || rawHex.length === 0 || rawHex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(rawHex)) {
    throw new Error('Fetched transaction must be non-empty canonical hexadecimal bytes')
  }
  if (!/^[0-9a-fA-F]{64}$/.test(expectedTxid)) {
    throw new Error('Expected transaction ID must be 32-byte hexadecimal')
  }
  const tx = Transaction.fromHex(rawHex)
  const got = tx.id('hex')
  if (got.toLowerCase() !== expectedTxid.toLowerCase()) {
    throw new Error(`Fetched tx hex txid mismatch: expected=${expectedTxid} got=${got}`)
  }
  return tx
}

/** Verify that a locking script is standard P2PKH and its hash160 matches the given public key. */
export function verifyP2PKHOwnership (lockingScript: LockingScript, publicKey: PublicKey): void {
  const chunks = lockingScript.chunks
  if (chunks.length !== 5) throw new Error('UTXO is not standard P2PKH')
  if (chunks[0].op !== 118) throw new Error('UTXO is not P2PKH (missing OP_DUP)')
  if (chunks[1].op !== 169) throw new Error('UTXO is not P2PKH (missing OP_HASH160)')
  if (chunks[2].data?.length !== 20) throw new Error('UTXO is not P2PKH (bad hash160)')
  if (chunks[3].op !== 136) throw new Error('UTXO is not P2PKH (missing OP_EQUALVERIFY)')
  if (chunks[4].op !== 172) throw new Error('UTXO is not P2PKH (missing OP_CHECKSIG)')

  const scriptHash = chunks[2].data
  const keyHash = publicKey.toHash() as number[]
  if (scriptHash.length !== keyHash.length) throw new Error('P2PKH hash160 length mismatch')
  for (let i = 0; i < scriptHash.length; i++) {
    if (scriptHash[i] !== keyHash[i]) throw new Error('UTXO P2PKH hash160 does not match provided key')
  }
}

/** @internal */
export function resolveAutoSigned (car: CreateActionResult, txid: string, vout: number): string {
  if (!car.txid || !/^[0-9a-f]{64}$/i.test(car.txid)) {
    throw new Error('createAction returned no signableTransaction and no valid txid')
  }
  if (car.tx == null) {
    throw new Error('Auto-signed createAction result omitted the transaction needed for validation')
  }
  const completedTx = Transaction.fromAtomicBEEF(car.tx)
  if (completedTx.id('hex').toLowerCase() !== car.txid.toLowerCase()) {
    throw new Error('Auto-signed tx id mismatch with car.txid')
  }
  const matchingInputs = completedTx.inputs.filter(
    inp => String(inp.sourceTXID).toLowerCase() === txid && inp.sourceOutputIndex === vout
  )
  if (matchingInputs.length !== 1) {
    throw new Error('Auto-signed tx must spend the requested outpoint exactly once')
  }
  return car.txid
}

/** @internal */
export async function signAndComplete (
  wallet: WalletInterface,
  st: SignableTransaction,
  txid: string,
  vout: number,
  satoshis: number,
  p2pkhKey: KeyPairAddress,
  getUnlockP2PKH: (priv: KeyPairAddress['privateKey'], satoshis: number) => ScriptTemplateUnlock
): Promise<string> {
  const unsignedTx = Transaction.fromAtomicBEEF(st.tx)
  const matchingInputIndexes = unsignedTx.inputs.flatMap((input, index) =>
    String(input.sourceTXID).toLowerCase() === txid && input.sourceOutputIndex === vout ? [index] : []
  )
  if (matchingInputIndexes.length !== 1) {
    throw new Error('Signable transaction must contain the requested outpoint exactly once')
  }
  const inputIndex = matchingInputIndexes[0]
  unsignedTx.inputs[inputIndex].unlockingScriptTemplate = getUnlockP2PKH(p2pkhKey.privateKey, satoshis)
  await unsignedTx.sign()
  const unlockingScript = unsignedTx.inputs[inputIndex].unlockingScript!.toHex()
  const sar = await wallet.signAction({ reference: st.reference, spends: { [inputIndex]: { unlockingScript } } })
  if (!sar.txid || !/^[0-9a-f]{64}$/i.test(sar.txid)) throw new Error('signAction returned no valid txid')
  const expectedTxid = unsignedTx.id('hex')
  if (sar.txid.toLowerCase() !== expectedTxid.toLowerCase()) {
    throw new Error('signAction returned a transaction ID that does not match the signed transaction')
  }
  if (sar.tx == null) {
    throw new Error('signAction omitted the final transaction needed for validation')
  }
  const finalized = Transaction.fromAtomicBEEF(sar.tx)
  if (finalized.id('hex').toLowerCase() !== expectedTxid.toLowerCase() || finalized.toHex() !== unsignedTx.toHex()) {
    throw new Error('signAction returned a transaction that does not match the signed transaction')
  }
  return sar.txid
}

/** @internal */
export async function importSingleOutpoint (
  wallet: WalletInterface,
  beef: Beef,
  beefBin: BEEF,
  parsed: ParsedOutpoint,
  p2pkhKey: KeyPairAddress,
  getUnlockP2PKH: (priv: KeyPairAddress['privateKey'], satoshis: number) => ScriptTemplateUnlock
): Promise<string> {
  const { outpoint, txid, vout } = parsed
  const btx = beef.findTxid(txid)
  if ((btx?.tx) == null) throw new Error(`Transaction ${txid} not found in inputBEEF`)
  if (vout < 0 || vout >= btx.tx.outputs.length) { throw new Error(`vout ${vout} out of range (tx has ${btx.tx.outputs.length} outputs)`) }
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
  if (car.signableTransaction == null) {
    return resolveAutoSigned(car, txid, vout)
  }
  return await signAndComplete(wallet, car.signableTransaction, txid, vout, satoshis, p2pkhKey, getUnlockP2PKH)
}

/**
 * Funds a BRC-100 wallet by importing P2PKH UTXOs.
 *
 * Accepts outpoints + a P2PKH key pair, optionally with a pre-built BEEF.
 * If no BEEF is provided, one is built via buildBeefForOutpoints.
 */
export async function fundWalletFromP2PKHOutpoints (
  wallet: WalletInterface,
  outpoints: string[],
  p2pkhKey: KeyPairAddress,
  getUnlockP2PKH: (priv: KeyPairAddress['privateKey'], satoshis: number) => ScriptTemplateUnlock,
  inputBEEF?: BEEF
): Promise<Array<{ outpoint: string, txid?: string, success: boolean, error?: string }>> {
  if (!Array.isArray(outpoints) || outpoints.length === 0 || outpoints.length > MAX_OUTPOINTS) {
    throw new Error(`outpoints must contain between 1 and ${MAX_OUTPOINTS} entries`)
  }
  const parsed = outpoints.map(o => parseOutpoint(o))
  const seen = new Set<string>()
  for (const p of parsed) {
    const key = `${p.txid}.${p.vout}`
    if (seen.has(key)) throw new Error(`Duplicate outpoint: ${key}`)
    seen.add(key)
  }
  const beefBin = inputBEEF ?? (await buildBeefForOutpoints(outpoints))
  const beef = Beef.fromBinaryStrict(beefBin)
  const results: Array<{ outpoint: string, txid?: string, success: boolean, error?: string }> = []
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
export async function buildBeefForOutpoints (outpoints: string[], maxDepth = 10): Promise<BEEF> {
  if (!Array.isArray(outpoints) || outpoints.length === 0 || outpoints.length > MAX_OUTPOINTS) {
    throw new Error(`outpoints must contain between 1 and ${MAX_OUTPOINTS} entries`)
  }
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 0 || maxDepth > 100) {
    throw new Error('maxDepth must be an integer from 0 to 100')
  }
  const beef = new Beef()
  const fetched = new Set<string>()
  let sourceBytes = 0

  async function fetchRawTx (txid: string): Promise<string | null> {
    const providers = [
      `https://ordinals.gorillapool.io/api/tx/${txid}/hex`,
      `https://api.whatsonchain.com/v1/bsv/main/tx/${txid}/hex`
    ]
    for (const url of providers) {
      try {
        const bytes = await fetchBounded(url, MAX_RAW_TX_HEX_BYTES, 'Raw transaction response')
        const rawHex = new TextDecoder('utf-8', { fatal: true }).decode(bytes).trim()
        parseTxAndAssertId(rawHex, txid)
        sourceBytes += bytes.length
        if (sourceBytes > MAX_BEEF_SOURCE_BYTES) {
          throw new FundingResourceLimitError(
            `BEEF source material exceeds ${MAX_BEEF_SOURCE_BYTES} bytes`
          )
        }
        return rawHex
      } catch (error) {
        if (error instanceof FundingResourceLimitError) throw error
        /* try next */
      }
    }
    return null
  }

  async function fetchMerklePath (txid: string): Promise<MerklePath | null> {
    try {
      const bytes = await fetchBounded(
        `https://ordinals.gorillapool.io/api/tx/${txid}/proof`,
        MAX_MERKLE_PATH_BYTES,
        'Merkle path response'
      )
      const merklePath = MerklePath.fromBinary(bytes)
      const canonical = merklePath.toBinary()
      if (canonical.length !== bytes.length || canonical.some((byte, index) => byte !== bytes[index])) {
        throw new Error('Merkle path response is not canonical')
      }
      merklePath.computeRoot(txid)
      sourceBytes += bytes.length
      if (sourceBytes > MAX_BEEF_SOURCE_BYTES) {
        throw new FundingResourceLimitError(
          `BEEF source material exceeds ${MAX_BEEF_SOURCE_BYTES} bytes`
        )
      }
      return merklePath
    } catch (error) {
      if (error instanceof FundingResourceLimitError) throw error
      return null
    }
  }

  async function addTxToBeef (txid: string, depth: number): Promise<void> {
    if (fetched.has(txid)) return
    if (depth > maxDepth) {
      throw new Error(`BEEF build exceeded maxDepth=${maxDepth} while resolving ${txid}`)
    }
    if (fetched.size >= MAX_BEEF_TRANSACTIONS) {
      throw new Error(`BEEF build exceeds ${MAX_BEEF_TRANSACTIONS} transactions`)
    }
    fetched.add(txid)

    const rawHex = await fetchRawTx(txid)
    if (!rawHex) throw new Error(`Failed to fetch raw transaction ${txid} from any provider`)

    const tx = parseTxAndAssertId(rawHex, txid)
    const merklePath = await fetchMerklePath(txid)

    if (merklePath != null) {
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
