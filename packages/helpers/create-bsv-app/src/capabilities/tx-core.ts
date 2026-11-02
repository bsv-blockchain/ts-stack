import type { Capability, CapabilityContext, BaseBuilder } from '../types.js'
import { bsvImport } from '../scaffold/base-app.js'
import { layoutHasRole } from '../engine.js'
import { sectionLines } from './section-lines.js'
import { BSV_SDK_RANGE, WALLET_HELPER_RANGE, WALLET_RELAY_RANGE } from './versions.js'

export const TX_UTILS_SOURCE = `// Read and handle transactions: parse BEEF / AtomicBEEF / raw bytes, summarize, find outputs, pass outpoints and BEEF around.
import { Beef, Transaction, Utils } from '@bsv/sdk'
import type { ListOutputsArgs, WalletInterface, WalletOutput } from '@bsv/sdk'
import { getScriptType } from '@bsv/wallet-helper'
import type { ScriptType } from '@bsv/wallet-helper'

/** Bytes, or a hex / base64 string of them. */
export type TxInput = string | number[] | Uint8Array

const PARSE_ERROR = 'Could not parse a transaction: expected BEEF, AtomicBEEF or a raw transaction, as bytes, hex or base64'

function toBytes (input: TxInput): number[] | Uint8Array {
  if (typeof input !== 'string') return input
  const text = input.trim()
  if (/^([0-9a-fA-F]{2})+$/.test(text)) return Utils.toArray(text, 'hex')
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(text) && text.length % 4 === 0) return Utils.toArray(text, 'base64')
  throw new Error(PARSE_ERROR)
}

/** Parse AtomicBEEF, then BEEF (the last transaction is the subject), then a raw transaction. */
export function parseTransaction (input: TxInput): Transaction {
  const bytes = toBytes(input)
  const attempts = [Transaction.fromAtomicBEEF, Transaction.fromBEEF, Transaction.fromBinary]
  for (const attempt of attempts) {
    try {
      return attempt(bytes)
    } catch {
      // try the next format
    }
  }
  throw new Error(PARSE_ERROR)
}

export interface OutputSummary {
  vout: number
  satoshis: number
  scriptType: ScriptType
  /** OP_RETURN pushes decoded as UTF-8. Only set for OpReturn outputs. */
  data?: string[]
}

export interface TransactionSummary {
  txid: string
  inputs: Array<{ outpoint: string }>
  outputs: OutputSummary[]
}

// The pushes after OP_RETURN, read from the raw script bytes. An OP_0 push is an empty string ''.
function opReturnPushes (script: number[], start: number): string[] {
  const pushes: string[] = []
  let i = start
  while (i < script.length) {
    const op = script[i++]
    let length: number
    if (op < 0x4c) length = op
    else if (op === 0x4c) { length = script[i]; i += 1 }
    else if (op === 0x4d) { length = script[i] | (script[i + 1] << 8); i += 2 }
    else if (op === 0x4e) { length = (script[i] | (script[i + 1] << 8) | (script[i + 2] << 16) | (script[i + 3] << 24)) >>> 0; i += 4 }
    else break
    // A cut-off script leaves a missing length (NaN), which fails this check and stops the loop.
    // PUSHDATA4's length is read unsigned (>>> 0) so a huge value cannot go negative and pass.
    if (!(i + length <= script.length)) break
    pushes.push(Utils.toUTF8(script.slice(i, i + length)))
    i += length
  }
  return pushes
}

/** txid, input outpoints, and per-output satoshis, script type and (for OP_RETURN) the data pushes. */
export function summarizeTransaction (tx: Transaction): TransactionSummary {
  return {
    txid: tx.id('hex'),
    inputs: tx.inputs.map((input, index) => {
      const sourceTxid = input.sourceTXID ?? input.sourceTransaction?.id('hex')
      if (sourceTxid === undefined) throw new Error(\`input \${index} has no source transaction id\`)
      return { outpoint: formatOutpoint(sourceTxid, input.sourceOutputIndex) }
    }),
    outputs: tx.outputs.map((output, vout) => {
      const hex = output.lockingScript.toHex()
      const satoshis = output.satoshis ?? 0
      // OP_FALSE OP_RETURN is the modern data carrier; getScriptType only recognizes a bare OP_RETURN.
      if (hex.startsWith('006a')) {
        return { vout, satoshis, scriptType: 'OpReturn' as const, data: opReturnPushes(output.lockingScript.toBinary(), 2) }
      }
      const scriptType = getScriptType(hex)
      if (scriptType === 'OpReturn') {
        return { vout, satoshis, scriptType, data: opReturnPushes(output.lockingScript.toBinary(), 1) }
      }
      return { vout, satoshis, scriptType }
    })
  }
}

/**
 * Index of the single output paying lockingScriptHex (and satoshis, if given).
 * Wallets randomise output order and may add outputs you did not ask for, so never assume a vout.
 */
export function findOutputByScript (tx: Transaction, lockingScriptHex: string, satoshis?: number): number {
  const wanted = lockingScriptHex.toLowerCase()
  const matches: number[] = []
  tx.outputs.forEach((output, index) => {
    if (output.lockingScript.toHex() === wanted && (satoshis === undefined || output.satoshis === satoshis)) matches.push(index)
  })
  if (matches.length !== 1) throw new Error(\`expected exactly one matching output in \${tx.id('hex')}, found \${matches.length}\`)
  return matches[0]
}

/** WhatsOnChain page for a transaction. undefined for ttn (no public explorer) or a txid that is not 64 hex characters. */
export function explorerTxUrl (txid: string, network: 'main' | 'test' | 'ttn'): string | undefined {
  if (!/^[0-9a-fA-F]{64}$/.test(txid) || network === 'ttn') return undefined
  return (network === 'main' ? 'https://whatsonchain.com/tx/' : 'https://test.whatsonchain.com/tx/') + txid.toLowerCase()
}

/** "<txid>.<vout>", the outpoint form wallets use. */
export function formatOutpoint (txid: string, vout: number): string {
  if (!/^[0-9a-fA-F]{64}$/.test(txid) || !Number.isInteger(vout) || vout < 0 || vout > 0xffffffff) {
    throw new Error(\`invalid outpoint: \${txid}.\${vout}\`)
  }
  return \`\${txid.toLowerCase()}.\${vout}\`
}

export function parseOutpoint (outpoint: string): { txid: string, vout: number } {
  const match = /^([0-9a-fA-F]{64})\\.(0|[1-9][0-9]*)$/.exec(outpoint)
  const vout = match === null ? NaN : Number(match[2])
  if (match === null || vout > 0xffffffff) throw new Error(\`invalid outpoint: \${outpoint}\`)
  return { txid: match[1].toLowerCase(), vout }
}

// BEEF helpers. BEEF travels over JSON as base64, never as a number[] array.
export function encodeBeef (beef: number[] | Uint8Array): string {
  return Utils.toBase64(Array.from(beef))
}

/** Throws on non-base64 input. */
export function decodeBeef (beefBase64: string): number[] {
  return Utils.toArray(beefBase64, 'base64')
}

/** One inputBEEF for an action that spends outputs from several source transactions. */
export function mergeBeefs (beefs: Array<number[] | Uint8Array>): number[] | Uint8Array {
  if (beefs.length === 0) throw new Error('mergeBeefs needs at least one BEEF')
  if (beefs.length === 1) return beefs[0]
  const merged = new Beef()
  for (const beef of beefs) merged.mergeBeef(beef)
  return merged.toBinary()
}

export interface CarriedOutput {
  outpoint: string
  satoshis: number
  lockingScript: string
  /** base64 BEEF of the creating transaction: everything a spender needs as inputBEEF. */
  beef: string
}

/**
 * "Creator carries the BEEF": whoever creates an output returns/stores this record so the
 * spender never has to look the source transaction up. Call it after persisting the txid:
 * it throws if the transaction's ancestry is incomplete.
 */
export function carryOutput (tx: Transaction, vout: number): CarriedOutput {
  const output = tx.outputs[vout]
  if (output == null) throw new Error(\`output \${vout} does not exist in \${tx.id('hex')}\`)
  if (output.satoshis == null) throw new Error(\`output \${vout} has no satoshi amount\`)
  return {
    outpoint: formatOutpoint(tx.id('hex'), vout),
    satoshis: output.satoshis,
    lockingScript: output.lockingScript.toHex(),
    beef: encodeBeef(tx.toBEEF())
  }
}

/**
 * Every output in a basket (optionally tag-scoped), paging past listOutputs' default limit of 10.
 * Scope with tags: with include 'entire transactions' each page carries BEEF for all its outputs.
 */
export async function listAllOutputs (
  wallet: WalletInterface,
  args: Omit<ListOutputsArgs, 'limit' | 'offset'>,
  pageSize = 100
): Promise<{ outputs: WalletOutput[], beef?: number[] }> {
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 10_000) throw new Error('pageSize must be 1..10000')
  const outputs: WalletOutput[] = []
  const merged = new Beef()
  let sawBeef = false
  let offset = 0
  for (;;) {
    const page = await wallet.listOutputs({ ...args, limit: pageSize, offset })
    outputs.push(...page.outputs)
    if (page.BEEF != null) { merged.mergeBeef(page.BEEF); sawBeef = true }
    offset += page.outputs.length
    if (page.outputs.length === 0 || offset >= page.totalOutputs) break
  }
  return sawBeef ? { outputs, beef: merged.toBinary() } : { outputs }
}
`

export const TRANSACTIONS_SOURCE = `// The building blocks for transactions: TransactionBuilder, script support, a data-output script,
// and receiving a payment to your own wallet. TransactionsDemo.tsx shows them put together.
import { LockingScript, OP, Utils } from '@bsv/sdk'
import type { WalletInterface } from '@bsv/sdk'
import { getAddress } from '@bsv/wallet-helper'

// Building and sending transactions
export { TransactionBuilder, WalletP2PKH, getScriptType, isP2PKH, extractOpReturnData } from '@bsv/wallet-helper'
export { Script, LockingScript, UnlockingScript, OP, P2PKH, Transaction, Beef, Utils } from '@bsv/sdk'

/** OP_FALSE OP_RETURN <utf8 field>... — a 0-satoshi data output script. Throws on an empty list or a non-string field. */
export function dataScript (fields: string[]): LockingScript {
  if (!Array.isArray(fields) || fields.length === 0) throw new Error('fields must be a non-empty array')
  if (!fields.every(field => typeof field === 'string')) throw new Error('every field must be a string')
  // writeBin picks the right push opcode for each field's length.
  const script = new LockingScript().writeOpCode(OP.OP_FALSE).writeOpCode(OP.OP_RETURN)
  for (const field of fields) script.writeBin(Utils.toArray(field, 'utf8'))
  return script
}

export interface OwnAddress {
  address: string
  derivationPrefix: string
  derivationSuffix: string
}

/**
 * A fresh address your wallet can spend (BRC-29 derivation, counterparty 'self', via wallet-helper getAddress).
 * Payments to it only count toward the wallet balance once internalized (see internalizePayment).
 * Mainnet address format.
 */
export async function deriveOwnAddress (wallet: WalletInterface): Promise<OwnAddress> {
  const [{ address, walletParams }] = await getAddress(wallet)
  // keyID is "<derivationPrefix> <derivationSuffix>".
  const [derivationPrefix, derivationSuffix] = walletParams.keyID.split(' ')
  return { address, derivationPrefix, derivationSuffix }
}

export interface InternalizePaymentArgs {
  /** AtomicBEEF bytes of the transaction, exactly as the wallet returned them */
  tx: number[]
  outputIndex: number
  derivationPrefix: string
  derivationSuffix: string
  /** Defaults to your own identity key (a payment to yourself) */
  senderIdentityKey?: string
  /** Defaults to 'Receive payment' (wallets require 5+ characters) */
  description?: string
}

/**
 * Hand a BRC-29 payment output to the wallet (internalizeAction, protocol 'wallet payment') so it counts
 * toward the balance. The wallet must have processed the transaction first: create it with acceptDelayedBroadcast: false.
 */
export async function internalizePayment (wallet: WalletInterface, args: InternalizePaymentArgs): Promise<void> {
  if (!Number.isSafeInteger(args.outputIndex) || args.outputIndex < 0) throw new Error('outputIndex must be a whole number, 0 or more')
  if (!Array.isArray(args.tx) || args.tx.length === 0) throw new Error('tx must be the transaction bytes the wallet returned')
  const senderIdentityKey = args.senderIdentityKey ?? (await wallet.getPublicKey({ identityKey: true })).publicKey
  await wallet.internalizeAction({
    tx: args.tx,
    outputs: [{
      outputIndex: args.outputIndex,
      protocol: 'wallet payment',
      paymentRemittance: { derivationPrefix: args.derivationPrefix, derivationSuffix: args.derivationSuffix, senderIdentityKey }
    }],
    description: args.description ?? 'Receive payment'
  })
}
`

const TRANSACTIONS_DEMO_SOURCE = `import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Utils } from '@bsv/sdk'
import type { Transaction, WalletInterface } from '@bsv/sdk'
import { ConnectWallet } from './ConnectWallet.js'
import { BSV_NETWORK } from './config.js'
import { useWallet } from './WalletContext.js'
import { P2PKH, TransactionBuilder, dataScript, deriveOwnAddress, internalizePayment } from './transactions.js'
import { explorerTxUrl, findOutputByScript, parseTransaction, summarizeTransaction } from './txUtils.js'

type Network = 'main' | 'test' | 'ttn'

interface Recovery {
  address: string
  derivationPrefix: string
  derivationSuffix: string
  outpoint?: string
  error: string
}

// A finished transaction: its txid and the parsed tx (when the wallet returned one).
interface TxResult {
  txid: string
  tx?: Transaction
  /** Only for Send to myself: whether the wallet took the payment back, and how to recover it if not. */
  self?: { internalized: boolean, recovery?: Recovery }
}

// Example built from the core blocks: publish text on-chain as one 0-satoshi data output.
// Copy and change it for your own data.
async function publishNote (wallet: WalletInterface, text: string): Promise<{ txid: string, vout: number, tx: Transaction }> {
  const lockingScript = dataScript([text])
  const builder = new TransactionBuilder(wallet, 'Publish data')
  builder.addCustomOutput({ lockingScript, satoshis: 0, description: 'Data output' })
  const result: { txid?: string, tx?: number[] } = await builder.build()
  if (result.txid == null) throw new Error('wallet returned no txid')
  if (result.tx == null) throw new Error('wallet returned no transaction')
  const tx = parseTransaction(result.tx)
  // Wallets may reorder outputs and add change, so look the data output up by its script
  // rather than assuming it is output 0. This throws if it is missing.
  const vout = findOutputByScript(tx, lockingScript.toHex(), 0)
  return { txid: result.txid, vout, tx }
}

// Example built from the core blocks: pay satoshis to a base58 address or a 66-hex public key.
async function sendSats (wallet: WalletInterface, to: string, satoshis: number): Promise<{ txid: string, tx?: Transaction }> {
  if (to === '') throw new Error('destination is required')
  if (!Number.isSafeInteger(satoshis) || satoshis <= 0) throw new Error('satoshis must be a positive whole number')
  const result: { txid?: string, tx?: number[] } = await new TransactionBuilder(wallet, 'Send satoshis').pay(to, satoshis)
  if (result.txid == null) throw new Error('wallet returned no txid')
  return result.tx == null ? { txid: result.txid } : { txid: result.txid, tx: parseTransaction(result.tx) }
}

// Example built from the core blocks: get an address of your own, pay it, then internalize the payment
// so it comes back to your balance. Never throws once the payment is sent: if internalizing fails,
// recovery has the address and derivation to get the sats back with.
async function sendToSelf (wallet: WalletInterface, satoshis: number): Promise<{ txid: string, tx?: Transaction, internalized: boolean, recovery?: Recovery }> {
  if (!Number.isSafeInteger(satoshis) || satoshis <= 0) throw new Error('satoshis must be a positive whole number')
  const { address, derivationPrefix, derivationSuffix } = await deriveOwnAddress(wallet)
  const recovery = { address, derivationPrefix, derivationSuffix }
  // Broadcast now (acceptDelayedBroadcast: false): a wallet can only take the payment back once it has processed the transaction.
  const builder = new TransactionBuilder(wallet, 'Send to self').options({ acceptDelayedBroadcast: false })
  const sent: { txid?: string, tx?: number[] } = await builder.pay(address, satoshis)
  if (sent.txid == null) throw new Error('wallet returned no txid')
  const txid = sent.txid
  if (sent.tx == null) {
    return { txid, internalized: false, recovery: { ...recovery, error: 'wallet returned no transaction to internalize' } }
  }
  let tx: Transaction | undefined
  let outpoint: string | undefined
  try {
    tx = parseTransaction(sent.tx)
    const outputIndex = findOutputByScript(tx, new P2PKH().lock(address).toHex(), satoshis)
    outpoint = txid + '.' + String(outputIndex)
    // The bytes the wallet returned, unchanged.
    await internalizePayment(wallet, { tx: sent.tx, outputIndex, derivationPrefix, derivationSuffix, description: 'Receive own payment' })
    return { txid, tx, internalized: true }
  } catch (e) {
    return { txid, ...(tx === undefined ? {} : { tx }), internalized: false, recovery: { ...recovery, ...(outpoint === undefined ? {} : { outpoint }), error: errorText(e) } }
  }
}

// The wallet derives a mainnet-format address; on test and ttn show the same key's testnet address.
function addressForNetwork (address: string, network: Network): string {
  if (network === 'main') return address
  try {
    return Utils.toBase58Check(Utils.fromBase58Check(address).data as number[], [0x6f])
  } catch {
    return address
  }
}

// Ask the wallet which network it is on: 'mainnet' is main, anything else is test. Paired phone wallets
// do not forward getNetwork, so null means "unknown" and the app's configured network is used instead.
async function askWalletNetwork (wallet: WalletInterface): Promise<'main' | 'test' | null> {
  try {
    const { network } = await wallet.getNetwork({})
    return network === 'mainnet' ? 'main' : 'test'
  } catch {
    return null
  }
}

function show (value: unknown): string {
  return JSON.stringify(value, null, 2)
}

function errorText (e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

// A whole number of satoshis above zero, or null. Nothing is sent until this is a number.
function readAmount (text: string): number | null {
  if (!/^[0-9]+$/.test(text.trim())) return null
  const amount = Number(text)
  return Number.isSafeInteger(amount) && amount > 0 ? amount : null
}

export function TransactionsDemo () {
  const { wallet, connected } = useWallet()

  // Publish a note
  const [note, setNote] = useState('')
  const [noteResult, setNoteResult] = useState<TxResult | null>(null)
  const [noteError, setNoteError] = useState<string | null>(null)

  // Send satoshis
  const [to, setTo] = useState('')
  const [amountText, setAmountText] = useState('')
  const [confirming, setConfirming] = useState(false)
  // True when the pending confirm is for Send to myself rather than Send.
  const [toSelf, setToSelf] = useState(false)
  const [sendResult, setSendResult] = useState<TxResult | null>(null)
  const [sendError, setSendError] = useState<string | null>(null)

  // Read a transaction
  const [raw, setRaw] = useState('')
  const [readResult, setReadResult] = useState<string | null>(null)
  const [readError, setReadError] = useState<string | null>(null)

  // True while a wallet call is in flight: Publish, Send and Confirm are disabled until it settles.
  const [busy, setBusy] = useState(false)
  // Also a ref: a second click can arrive before the re-render that disables the button.
  const inFlight = useRef(false)

  // The wallet's own network, asked once per connected wallet. It never blocks a result: until it
  // arrives (or if it never does) links use the configured network.
  // The answer is stored with the wallet it came from, so a different wallet never shows it.
  const [answer, setAnswer] = useState<{ wallet: WalletInterface, network: 'main' | 'test' | null } | null>(null)
  useEffect(() => {
    if (wallet === null) return
    let stale = false
    void askWalletNetwork(wallet).then(network => { if (!stale) setAnswer({ wallet, network }) })
    return () => { stale = true }
  }, [wallet])
  const walletNetwork = answer !== null && answer.wallet === wallet ? answer.network : null
  // ttn has no explorer, so a wallet answer never replaces it.
  const network: Network = BSV_NETWORK === 'ttn' ? 'ttn' : walletNetwork ?? BSV_NETWORK

  const amount = readAmount(amountText)
  const canSend = to.trim() !== '' && amount !== null

  const publish = async () => {
    if (wallet === null || inFlight.current) return
    setNoteError(null); setNoteResult(null)
    inFlight.current = true
    setBusy(true)
    try {
      const result = await publishNote(wallet, note)
      setNoteResult({ txid: result.txid, tx: result.tx })
    } catch (e) { setNoteError(errorText(e)) } finally { inFlight.current = false; setBusy(false) }
  }

  const send = async () => {
    setConfirming(false)
    if (wallet === null || amount === null || inFlight.current) return
    setSendError(null); setSendResult(null)
    inFlight.current = true
    setBusy(true)
    try {
      if (toSelf) {
        const result = await sendToSelf(wallet, amount)
        setSendResult({ txid: result.txid, tx: result.tx, self: { internalized: result.internalized, recovery: result.recovery } })
      } else {
        const result = await sendSats(wallet, to.trim(), amount)
        setSendResult({ txid: result.txid, tx: result.tx })
      }
    } catch (e) { setSendError(errorText(e)) } finally { inFlight.current = false; setBusy(false) }
  }

  // Reading is local: it never touches the wallet.
  const read = () => {
    setReadError(null); setReadResult(null)
    try {
      setReadResult(show(summarizeTransaction(parseTransaction(raw))))
    } catch (e) { setReadError(errorText(e)) }
  }

  // Put a transaction from one of the results above into the reader and show what it reads.
  const tryWithReader = (tx: Transaction) => {
    setRaw(tx.toHex())
    setReadError(null)
    setReadResult(show(summarizeTransaction(tx)))
    if (typeof document !== 'undefined') document.getElementById('tx-reader')?.scrollIntoView?.({ behavior: 'smooth' })
  }

  // The txid as a link that opens the explorer in a new tab (plain text when the network has no explorer), plus the reader button.
  const resultView = (result: TxResult) => {
    const url = explorerTxUrl(result.txid, network)
    const tx = result.tx
    return (
      <p className="bsv-result">
        {url === undefined
          ? <code>{result.txid}</code>
          : <a href={url} target="_blank" rel="noopener noreferrer">{result.txid}</a>}
        {tx !== undefined && <button className="bsv-btn-ghost" onClick={() => tryWithReader(tx)}>Try with the tx reader</button>}
      </p>
    )
  }

  return (
    <main className="bsv-page">
      <Link className="bsv-back" to="/">← Back to home</Link>
      <h1>Transactions</h1>
      <p>Publish data, send satoshis and read transactions with your wallet.</p>
      <ConnectWallet />
      {connected && (
        <section>
          <h2>Publish a note</h2>
          <input className="bsv-input" value={note} placeholder="Text to publish on-chain" onChange={e => setNote(e.target.value)} />
          <button className="bsv-btn" disabled={busy || note.trim() === ''} onClick={() => { void publish() }}>Publish</button>
          {noteResult != null && resultView(noteResult)}
          {noteError != null && <p className="bsv-err">{noteError}</p>}
        </section>
      )}
      {connected && (
        <section>
          <h2>Send satoshis</h2>
          <input className="bsv-input" value={to} placeholder="Address" onChange={e => { setTo(e.target.value); setConfirming(false) }} />
          <input className="bsv-input" value={amountText} placeholder="Satoshis" onChange={e => { setAmountText(e.target.value); setConfirming(false) }} />
          {!confirming && <button className="bsv-btn" disabled={busy || !canSend} onClick={() => { setToSelf(false); setConfirming(true) }}>Send</button>}
          {!confirming && <button className="bsv-btn" disabled={busy || amount === null} onClick={() => { setToSelf(true); setConfirming(true) }}>Send to myself</button>}
          {confirming && (
            <div>
              <p>{toSelf ? 'Send ' + String(amount) + ' satoshis to yourself?' : 'Send ' + String(amount) + ' satoshis to ' + to.trim() + '?'}</p>
              {toSelf
                ? <p>Your wallet derives a fresh address and adds the payment back to your balance.</p>
                : <p>Plain payments to an address or identity key are not detected by BRC-100 wallets unless the recipient internalizes them.</p>}
              <button className="bsv-btn" disabled={busy} onClick={() => { void send() }}>Confirm</button>
              <button className="bsv-btn-ghost" onClick={() => setConfirming(false)}>Cancel</button>
            </div>
          )}
          {sendResult != null && resultView(sendResult)}
          {sendResult?.self?.internalized === true && <p>Added back to your wallet balance.</p>}
          {sendResult?.self?.internalized === false && sendResult.self.recovery !== undefined && (
            <p className="bsv-err">{'Your wallet did not take the payment back: ' + sendResult.self.recovery.error + '. The sats are at ' + addressForNetwork(sendResult.self.recovery.address, network) + '; derivation prefix/suffix: ' + sendResult.self.recovery.derivationPrefix + ' / ' + sendResult.self.recovery.derivationSuffix + ' (BRC-29, counterparty self).' + (sendResult.self.recovery.outpoint === undefined ? '' : ' Look for output ' + sendResult.self.recovery.outpoint + '.')}</p>
          )}
          {sendError != null && <p className="bsv-err">{sendError}</p>}
        </section>
      )}
      {connected && (
        <section id="tx-reader">
          <h2>Read a transaction</h2>
          <textarea className="bsv-input" value={raw} placeholder="Paste a transaction as hex or base64 (BEEF, AtomicBEEF or raw)" onChange={e => setRaw(e.target.value)} />
          <button className="bsv-btn" disabled={raw.trim() === ''} onClick={read}>Read</button>
          {readResult != null && <pre className="bsv-result">{readResult}</pre>}
          {readError != null && <p className="bsv-err">{readError}</p>}
        </section>
      )}
    </main>
  )
}
`

// Client-only: a layout without a client gets no TransactionsDemo.tsx, so its section omits the demo.
const TX_DEMO_HOW = ` The demo page is client-only.
- \`TransactionsDemo.tsx\` is the worked example: it builds three flows out of these blocks as local functions you can copy.`
const TX_DEMO_SECTION = `

Demo (\`TransactionsDemo.tsx\`, client page at \`/transactions\`), three example flows built from the core:
- \`publishNote(wallet, text)\` — \`dataScript([text])\` as a 0-satoshi \`addCustomOutput\`, \`build\`, then \`findOutputByScript\` to locate the data output; resolves \`{ txid, vout, tx }\`.
- \`sendSats(wallet, to, satoshis)\` — \`TransactionBuilder.pay\` to a base58 address or 66-hex public key. Plain P2PKH payments to an address or identity key are not detected by BRC-100 wallets unless the recipient internalizes them.
- \`sendToSelf(wallet, satoshis)\` — \`deriveOwnAddress\`, \`pay\` it with \`acceptDelayedBroadcast: false\`, then \`internalizePayment\` the output found by script. It never throws once the payment is sent; if internalizing fails it returns the address, derivation prefix/suffix, error and (when found) the outpoint needed to recover the sats.
- The page has a confirm step before any send, shows each txid as a WhatsOnChain link (new tab) with a "Try with the tx reader" button, and reads a pasted transaction.`

const CUSTOM_SPEND = `- Spend your own script outputs with \`TransactionBuilder.addCustomInput\`; carry the source output's BEEF with \`carryOutput\`.`
// The relay's phone wallet is reachable only through the client's wallet-connect.
const PHONE_WALLET_ABORT = `- A paired phone wallet (wallet-relay ${WALLET_RELAY_RANGE}) cannot abort a failed custom spend, so its inputs stay unavailable until the phone wallet expires the action.`

function agentsSection(ctx: CapabilityContext): string {
  const demo = layoutHasRole(ctx.layout, 'client')
  // without a client there is no connected wallet: server code passes its own
  const wallet = demo
    ? 'the connected wallet'
    : 'the wallet your server code passes in (any `WalletInterface`, such as a server wallet)'
  return `## tx-core

Build, send and read BSV transactions. Wraps \`@bsv/wallet-helper\`'s \`TransactionBuilder\` and the \`@bsv/sdk\` \`Transaction\` / BEEF types, so ${wallet} funds, signs and broadcasts for you.

### How it works
- \`transactions.ts\` holds the building blocks: \`TransactionBuilder\` and script support, plus three small helpers. A \`TransactionBuilder\` hands your outputs to ${wallet}, which selects inputs, adds change, signs and returns the transaction as AtomicBEEF.
- \`txUtils.ts\` reads what comes back (and anything you paste): BEEF, AtomicBEEF or a raw transaction, as bytes, hex or base64.
- Both files are plain functions with no React in them, so they are copied to every side of your app that gets \`src/bsv\` (client, server, or both).${demo ? TX_DEMO_HOW : ''}

### How it's used
Core (\`transactions.ts\`):
- \`TransactionBuilder\`, \`WalletP2PKH\`, \`getScriptType\`, \`isP2PKH\`, \`extractOpReturnData\` (from \`@bsv/wallet-helper\`) and \`Script\`, \`LockingScript\`, \`UnlockingScript\`, \`OP\`, \`P2PKH\`, \`Transaction\`, \`Beef\`, \`Utils\` (from \`@bsv/sdk\`), re-exported so one import covers building and sending.
- \`dataScript(fields)\` — an OP_FALSE OP_RETURN script carrying UTF-8 fields, for a 0-satoshi data output.
- \`deriveOwnAddress(wallet)\` — a fresh BRC-29 address of your own wallet (counterparty \`self\`, via wallet-helper \`getAddress\`), with its derivation prefix and suffix. The address is mainnet-format; convert it for a test network. Payments to it only count toward your balance once internalized.
- \`internalizePayment(wallet, { tx, outputIndex, derivationPrefix, derivationSuffix })\` — \`internalizeAction\` with protocol \`wallet payment\`, so the wallet adds the output to its balance. The sender defaults to your own identity key.

Helpers (\`txUtils.ts\`):
- \`parseTransaction(input)\` — AtomicBEEF, BEEF or raw bytes/hex/base64 to a \`Transaction\`.
- \`summarizeTransaction(tx)\` — \`{ txid, inputs, outputs }\` with script types and decoded OP_RETURN data.
- \`findOutputByScript(tx, lockingScriptHex, satoshis?)\` — the vout of the output you made.
- \`explorerTxUrl(txid, network)\` — WhatsOnChain link for a transaction (\`undefined\` on ttn or for a bad txid).
- \`formatOutpoint\` / \`parseOutpoint\` — \`txid.vout\` strings.
- \`encodeBeef\` / \`decodeBeef\` / \`mergeBeefs\` — BEEF as base64 for transport; merge several into one.
- \`carryOutput(tx, vout)\` — an output plus the BEEF needed to spend it elsewhere.
- \`listAllOutputs(wallet, args)\` — every page of \`listOutputs\`.${demo ? TX_DEMO_SECTION : ''}

### Transaction rules
- Never assume a vout. Wallets may reorder outputs and add change; find yours with \`findOutputByScript\`.
- BEEF travels as base64 in JSON, never as a number array.
- \`listOutputs\` is paginated; use \`listAllOutputs\` instead of reading one page.
- \`internalizePayment\` needs the wallet to have processed the transaction, so create it with \`acceptDelayedBroadcast: false\`. Elsewhere the wallet's own behaviour decides whether it broadcasts now or later.

### Advanced
${sectionLines(CUSTOM_SPEND, demo && PHONE_WALLET_ABORT)}

### Future integrations
- Payments: take payment for an API call or a purchase with \`TransactionBuilder.pay\` and inspect the transaction with \`parseTransaction\`. Verifying a payment (SPV \`tx.verify\`) is a separate step the payments capability will own.
- Tokens: build token outputs with \`TransactionBuilder\` custom outputs and track them with \`listAllOutputs\`.
`
}

export const txCore: Capability = {
  id: 'tx-core',
  title: 'Transactions (build, send, read)',
  description:
    'TransactionBuilder and script support, data-output scripts, own-address payments, and transaction/BEEF parsing, plus a demo page.',
  // only the client demo page imports wallet-connect; the shared helpers need just the SDK
  requires: [{ id: 'wallet-connect', role: 'client' }],
  roles: ['shared', 'client'],
  defaultSelected: true,
  files: () => ({
    shared: [
      { path: 'txUtils.ts', content: TX_UTILS_SOURCE },
      { path: 'transactions.ts', content: TRANSACTIONS_SOURCE }
    ],
    client: [{ path: 'TransactionsDemo.tsx', content: TRANSACTIONS_DEMO_SOURCE }]
  }),
  baseEdits: ({ builder, ctx }: { builder: BaseBuilder; ctx: CapabilityContext }) => {
    builder.app.routes.push({
      path: '/transactions',
      component: 'TransactionsDemo',
      importPath: bsvImport(ctx, 'TransactionsDemo'),
      label: 'Transactions'
    })
  },
  npmDependencies: () => ({
    shared: { '@bsv/sdk': BSV_SDK_RANGE, '@bsv/wallet-helper': WALLET_HELPER_RANGE }
  }),
  agentsSection
}
