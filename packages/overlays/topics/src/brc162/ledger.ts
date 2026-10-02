// Layer A of the BRC-162 migration: the generic rules of BRC-162 (BSV-21 binary)
// and nothing else. No identity, trust or policy lives here, so any BRC-162 topic
// can reuse it. It reports spec verdicts per token id and never throws for a
// spec-invalid output; the Mandala layers (src/mandala) decide what to refuse.
//
// A token-shaped output the codec refuses is listed in `invalid`, never skipped,
// so a caller can turn "shaped like a token but not one" into a rejection.
import type { LockingScript, Transaction } from '@bsv/sdk'
import { Bsv21Binary, Bsv21BinaryError, isTokenShaped, tokenIdToString } from '@bsv/templates'
import type { Bsv21BinaryDecoded, Bsv21Role } from '@bsv/templates'

export interface Brc162Output {
  index: number
  satoshis: number
  role: Bsv21Role
  /** `<txid>_0`; a deploy names itself, so at vout 0 this is the tx's own id (`<txid>_<vout>` elsewhere). */
  tokenId: string
  amount: bigint
  payload?: number[]
  payloadCanonical: boolean
  restPubKeyHash?: number[]
}

export interface InvalidTokenOutput {
  index: number
  detail: string
}

export interface Brc162Input {
  index: number
  /** Only `authority` (amount 0) or `value` (amount > 0): a deploy source is read as what it carries. */
  role: Bsv21Role
  tokenId: string
  amount: bigint
  /** `<display txid>.<vout>` of the spent output. */
  outpoint: string
}

export interface TokenLedger {
  tokenId: string
  deployIndex?: number
  /** Input indices. */
  authorityIn: number[]
  /** Output indices, an authority deploy included. */
  authorityOut: number[]
  valueIn: bigint
  /** Every value output of the token, a fixed-supply deploy included. */
  valueOut: bigint
  valueInIndices: number[]
  valueOutIndices: number[]
}

export interface Brc162Classification {
  outputs: Brc162Output[]
  invalid: InvalidTokenOutput[]
}

export interface SpecVerdict {
  deployValid: boolean
  authorityOutputsValid: boolean
  valueOutputsValid: boolean
}

type TokenScript = { decoded: Bsv21BinaryDecoded } | { detail: string }

const deployTokenId = (txid: string, index: number): string => `${txid}_${index}`

// undefined: not token-shaped. Only the codec's own refusals are reported;
// anything else is a bug and propagates.
function readTokenScript(script: LockingScript): TokenScript | undefined {
  if (!isTokenShaped(script)) return undefined
  try {
    return { decoded: Bsv21Binary.decode(script) }
  } catch (error) {
    if (error instanceof Bsv21BinaryError) return { detail: error.message }
    throw error
  }
}

function toOutput(
  txid: string,
  index: number,
  satoshis: number,
  decoded: Bsv21BinaryDecoded
): Brc162Output {
  return {
    index,
    satoshis,
    role: decoded.role,
    tokenId:
      decoded.tokenId === undefined ? deployTokenId(txid, index) : tokenIdToString(decoded.tokenId),
    amount: decoded.amount,
    payload: decoded.payload,
    payloadCanonical: decoded.payloadCanonical,
    restPubKeyHash: decoded.restPubKeyHash
  }
}

/** Splits the outputs of `tx` into BRC-162 token outputs and token-shaped outputs the codec refuses. */
export function classifyOutputs(tx: Transaction): Brc162Classification {
  const txid = tx.id('hex')
  const outputs: Brc162Output[] = []
  const invalid: InvalidTokenOutput[] = []
  for (const [index, output] of tx.outputs.entries()) {
    const read = readTokenScript(output.lockingScript)
    if (read === undefined) continue
    if ('detail' in read) invalid.push({ index, detail: read.detail })
    else outputs.push(toOutput(txid, index, output.satoshis ?? 0, read.decoded))
  }
  return { outputs, invalid }
}

// A deploy has no id on the wire: it names the token by its own outpoint, and
// only vout 0 can. A deploy-shaped output elsewhere is no token input, so it
// can never be read as the real deploy of its transaction.
function inputTokenId(
  sourceTxid: string,
  vout: number,
  decoded: Bsv21BinaryDecoded
): string | undefined {
  if (decoded.tokenId !== undefined) return tokenIdToString(decoded.tokenId)
  return vout === 0 ? deployTokenId(sourceTxid, 0) : undefined
}

function readInput(tx: Transaction, index: number): Brc162Input | undefined {
  const spend = tx.inputs[index]
  const source = spend?.sourceTransaction
  if (source === undefined) return undefined
  const vout = spend.sourceOutputIndex
  const lockingScript = source.outputs[vout]?.lockingScript
  const read = lockingScript === undefined ? undefined : readTokenScript(lockingScript)
  if (read === undefined || !('decoded' in read)) return undefined
  const sourceTxid = source.id('hex')
  const tokenId = inputTokenId(sourceTxid, vout, read.decoded)
  if (tokenId === undefined) return undefined
  const { amount } = read.decoded
  return {
    index,
    role: amount === 0n ? 'authority' : 'value',
    tokenId,
    amount,
    outpoint: `${sourceTxid}.${vout}`
  }
}

/**
 * The token inputs among `previousCoins` (the input indices the engine
 * admitted), read from their source outputs, in ascending input order. Anything
 * else the transaction spends contributes nothing.
 */
export function classifyAdmittedInputs(
  tx: Transaction,
  previousCoins: readonly number[]
): Brc162Input[] {
  const inputs: Brc162Input[] = []
  for (const index of [...new Set(previousCoins)].sort((a, b) => a - b)) {
    const input = readInput(tx, index)
    if (input !== undefined) inputs.push(input)
  }
  return inputs
}

function emptyLedger(tokenId: string): TokenLedger {
  return {
    tokenId,
    authorityIn: [],
    authorityOut: [],
    valueIn: 0n,
    valueOut: 0n,
    valueInIndices: [],
    valueOutIndices: []
  }
}

// Amount 0 is authority, > 0 is value (BRC-162 Amounts), a deploy included.
function addOutput(ledger: TokenLedger, output: Brc162Output): void {
  if (output.role === 'deploy') ledger.deployIndex = output.index
  if (output.amount === 0n) {
    ledger.authorityOut.push(output.index)
  } else {
    ledger.valueOut += output.amount
    ledger.valueOutIndices.push(output.index)
  }
}

function addInput(ledger: TokenLedger, input: Brc162Input): void {
  if (input.amount === 0n) {
    ledger.authorityIn.push(input.index)
  } else {
    ledger.valueIn += input.amount
    ledger.valueInIndices.push(input.index)
  }
}

/**
 * Groups outputs and inputs by token id, outputs first, each in index order. A
 * token that is only spent still gets an entry (an authority ended, a balance
 * burned), so later layers see every token the transaction touches. A deploy
 * output is keyed by this transaction's own id and its index.
 */
export function buildLedger(
  txid: string,
  outputs: readonly Brc162Output[],
  inputs: readonly Brc162Input[]
): Map<string, TokenLedger> {
  const ledgers = new Map<string, TokenLedger>()
  const ledgerFor = (tokenId: string): TokenLedger => {
    const existing = ledgers.get(tokenId)
    if (existing !== undefined) return existing
    const created = emptyLedger(tokenId)
    ledgers.set(tokenId, created)
    return created
  }
  for (const output of outputs) {
    const tokenId = output.role === 'deploy' ? deployTokenId(txid, output.index) : output.tokenId
    addOutput(ledgerFor(tokenId), output)
  }
  for (const input of inputs) addInput(ledgerFor(input.tokenId), input)
  return ledgers
}

/**
 * BRC-162 Validation rules for one token in one transaction.
 *
 * - A deploy is valid genesis only at vout 0.
 * - An authority output needs an authority input, except the genesis deploy.
 * - Value outputs are valid with an authority input (mint), as genesis supply,
 *   or when the value inputs cover them (`I >= O`, all-or-nothing).
 */
export function specVerdicts(ledger: TokenLedger): SpecVerdict {
  const deployValid = ledger.deployIndex === undefined || ledger.deployIndex === 0
  const authorized = ledger.authorityIn.length > 0
  const isGenesis = (index: number): boolean => deployValid && index === ledger.deployIndex
  return {
    deployValid,
    authorityOutputsValid: authorized || ledger.authorityOut.every(isGenesis),
    valueOutputsValid:
      authorized || ledger.valueIn >= ledger.valueOut || ledger.valueOutIndices.every(isGenesis)
  }
}
