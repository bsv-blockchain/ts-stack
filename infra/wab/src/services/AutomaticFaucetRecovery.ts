import { Beef, Hash, MerklePath, Transaction, Utils, type WalletAction } from '@bsv/sdk'
import type { Wallet } from '@bsv/wallet-toolbox'
import type { PaymentEntity } from '../types'
import { faucetPaymentScript, saveRecoveredFaucetPayment } from './FaucetRecoveryService'

const MAX_LEGACY_ACTIONS = 1000
const MAX_EVIDENCE_BYTES = 8 * 1024 * 1024
const MAX_INPUTS = 32
const MAX_ANCESTORS = 64
const RECOVERY_BUDGET_MS = 30_000

function checkBudget(deadline: number): void {
  if (Date.now() > deadline) throw new Error('Faucet recovery traversal budget exceeded')
}

/** Durable correlation uses the secret already committed before wallet work, without disclosing it. */
export function faucetActionLabel(k: string): string {
  return `wab-faucet-${Utils.toHex(Hash.sha256(Utils.toArray(k, 'hex')))}`
}

function candidate(action: WalletAction, payment: PaymentEntity, script: string): boolean {
  return (
    /^[0-9a-f]{64}$/i.test(action.txid) &&
    ['unprocessed', 'unproven', 'completed', 'sending'].includes(action.status) &&
    action.outputs?.some(
      output =>
        output.outputIndex === payment.outputIndex &&
        output.satoshis === payment.amount &&
        output.lockingScript === script
    ) === true
  )
}

async function findRetainedAction(
  wallet: Wallet,
  payment: PaymentEntity,
  script: string,
  deadline: number
): Promise<string> {
  const label = faucetActionLabel(payment.k)
  const history = await wallet.listActions({
    labels: [label],
    labelQueryMode: 'all',
    includeLabels: true,
    includeOutputs: true,
    includeOutputLockingScripts: true,
    limit: 2
  })
  checkBudget(deadline)
  let matches = history.actions.filter(
    action => action.labels?.includes(label) && candidate(action, payment, script)
  )
  if (
    history.totalActions > 1 ||
    history.actions.length > 1 ||
    history.totalActions !== history.actions.length
  )
    throw new Error('Ambiguous faucet action history')
  if (history.totalActions === 0 && history.actions.length === 0) {
    // Compatibility for pre-label reservations, including already-stranded grants.
    // Refuse truncated/oversized history rather than guessing or creating another payment.
    const legacy = await wallet.listActions({
      labels: [],
      includeOutputs: true,
      includeOutputLockingScripts: true,
      limit: MAX_LEGACY_ACTIONS
    })
    checkBudget(deadline)
    if (legacy.totalActions > MAX_LEGACY_ACTIONS || legacy.actions.length !== legacy.totalActions) {
      throw new Error('Legacy faucet history needs operator reconciliation')
    }
    matches = legacy.actions.filter(action => candidate(action, payment, script))
  }
  if (matches.length !== 1) throw new Error('A unique retained faucet action is not available')
  const txid = matches[0].txid.toLowerCase()
  if (payment.txid != null && payment.txid !== txid)
    throw new Error('Conflicting faucet transaction checkpoint')
  return txid
}

async function retainedTransaction(
  wallet: Wallet,
  payment: PaymentEntity,
  txid: string,
  script: string,
  deadline: number
): Promise<Transaction> {
  const reqs = await wallet.storage.findProvenTxReqs({
    partial: {},
    txids: [txid],
    paged: { limit: 2, offset: 0 }
  })
  checkBudget(deadline)
  if (
    reqs.length !== 1 ||
    reqs[0].txid !== txid ||
    ![
      'unprocessed',
      'unsent',
      'sending',
      'unmined',
      'callback',
      'unconfirmed',
      'completed',
      'notifying'
    ].includes(reqs[0].status)
  ) {
    throw new Error('Retained faucet proof request is unavailable')
  }
  const raw = reqs[0].rawTx
  if (raw == null || raw.length > MAX_EVIDENCE_BYTES)
    throw new Error('Retained faucet transaction is unavailable')
  const transaction = Transaction.fromBinary([...raw])
  const output = transaction.outputs[payment.outputIndex]
  if (
    transaction.id('hex') !== txid ||
    transaction.toBinary().length !== raw.length ||
    transaction.toBinary().some((byte, index) => byte !== raw[index]) ||
    payment.outputIndex !== 0 ||
    output?.satoshis !== payment.amount ||
    output.lockingScript.toHex() !== script ||
    transaction.inputs.length > MAX_INPUTS
  )
    throw new Error('Retained faucet payment does not match reservation')

  return transaction
}

interface AncestorEvidence {
  parent: Transaction
  proof?: number[]
}

async function readAncestor(
  services: ReturnType<Wallet['getServices']>,
  sourceTxid: string,
  deadline: number
): Promise<AncestorEvidence> {
  const raw = await services.getRawTx(sourceTxid)
  if (raw.rawTx == null || raw.rawTx.length > MAX_EVIDENCE_BYTES)
    throw new Error('Faucet input unavailable')
  checkBudget(deadline)
  const parent = Transaction.fromBinary(raw.rawTx)
  if (parent.id('hex') !== sourceTxid || parent.inputs.length > MAX_INPUTS)
    throw new Error('Faucet input mismatch')
  const result = await services.getMerklePath(sourceTxid)
  checkBudget(deadline)
  return { parent, proof: result.merklePath?.toBinary() }
}

function scheduleInputs(
  inputs: Array<string | undefined>,
  queue: string[],
  scheduled: Set<string>
): void {
  for (const txid of inputs) {
    if (txid == null) throw new Error('Missing faucet input transaction')
    if (scheduled.has(txid)) continue
    if (scheduled.size >= MAX_ANCESTORS)
      throw new Error('Faucet ancestry exceeds transaction bound')
    scheduled.add(txid)
    queue.push(txid)
  }
}

async function readAncestry(
  beef: Beef,
  services: ReturnType<Wallet['getServices']>,
  queue: string[],
  scheduled: Set<string>,
  deadline: number
): Promise<void> {
  checkBudget(deadline)
  // Toolbox Services rotates shared fallback providers. Keep ancestor reads
  // sequential so one failed lookup cannot advance another lookup's cursor.
  const txid = queue.shift()
  if (txid == null) return
  const { parent, proof } = await readAncestor(services, txid, deadline)
  beef.mergeRawTx(parent.toBinary())
  if (proof != null) beef.mergeBump(MerklePath.fromBinary(proof))
  else
    scheduleInputs(
      parent.inputs.map(input => input.sourceTXID),
      queue,
      scheduled
    )
  if (beef.toBinary().length > MAX_EVIDENCE_BYTES)
    throw new Error('Faucet ancestry exceeds evidence bound')
  if (queue.length > 0) await readAncestry(beef, services, queue, scheduled, deadline)
}

async function verifiedRecoveryBeef(
  wallet: Wallet,
  transaction: Transaction,
  deadline: number
): Promise<number[]> {
  const beef = new Beef()
  const services = wallet.getServices()
  const queued: string[] = []
  const scheduled = new Set<string>()
  scheduleInputs(
    transaction.inputs.map(input => input.sourceTXID),
    queued,
    scheduled
  )
  await readAncestry(beef, services, queued, scheduled, deadline)
  beef.mergeRawTx(transaction.toBinary())
  const bytes = beef.toBinaryAtomic(transaction.id('hex'))
  const provider = await services.getChainTracker()
  const tracker = {
    currentHeight: async () => {
      checkBudget(deadline)
      const height = await provider.currentHeight()
      checkBudget(deadline)
      return height
    },
    isValidRootForHeight: async (root: string, height: number) => {
      checkBudget(deadline)
      const accepted = await provider.isValidRootForHeight(root, height)
      checkBudget(deadline)
      return accepted
    }
  }
  if (
    bytes.length > MAX_EVIDENCE_BYTES ||
    (await beef.verify(tracker)) !== true ||
    (await Transaction.fromAtomicBEEF(bytes).verify(tracker)) !== true
  ) {
    throw new Error('Faucet transaction verification failed')
  }
  return bytes
}

/** Read authenticated history, reprocess only its existing txid, and replay the same grant. */
export async function recoverFaucetPayment(payment: PaymentEntity, wallet: Wallet): Promise<void> {
  const deadline = Date.now() + RECOVERY_BUDGET_MS
  const script = faucetPaymentScript(payment.k)
  const txid = await findRetainedAction(wallet, payment, script, deadline)
  const transaction = await retainedTransaction(wallet, payment, txid, script, deadline)
  const bytes = await verifiedRecoveryBeef(wallet, transaction, deadline)
  checkBudget(deadline)
  // No outputs: sendWith reuses the signed transaction, never allocates a fresh grant.
  const result = await wallet.createAction({
    description: 'Resume existing faucet payment',
    options: { sendWith: [txid], acceptDelayedBroadcast: false }
  })
  if (
    result.sendWithResults?.length !== 1 ||
    result.sendWithResults[0].txid !== txid ||
    result.sendWithResults[0].status !== 'unproven'
  )
    throw new Error('Existing faucet submission is still pending')
  await saveRecoveredFaucetPayment(payment, txid, bytes)
}
