import {
  Beef,
  LockingScript,
  PrivateKey,
  ProtoWallet,
  Spend,
  Transaction,
  UnlockingScript,
  type CreateActionArgs,
  type CreateActionResult,
  type InternalizeActionArgs,
  type ListOutputsArgs,
  type ListOutputsResult,
  type LookupAnswer,
  type SignActionArgs,
  type SignActionResult,
  type STEAK,
  type WalletInterface
} from '@bsv/sdk'
import { hash160 } from '@bsv/sdk/primitives/Hash'
import Random from '@bsv/sdk/primitives/Random'
import { toArray, toBase64 } from '@bsv/sdk/primitives/utils'
import { OneColor } from '@bsv/templates'
import { sdk as toolbox } from '@bsv/wallet-toolbox-client'
import { ColorPermissionModule } from '../ColorPermissionModule.js'
import { assetBasket, COLOR_KEY_ID, colorProtocolID, colorTopic, ISSUE } from '../identifiers.js'
import { readTokenOutput } from '../tokenOutputs.js'

interface StoredOutput {
  tx: Transaction
  vout: number
  basket?: string
  customInstructions?: string
  reservedBy?: string
  spent: boolean
}

/** Validates one input's unlocking script against its source output with the script interpreter. */
export function validInput(tx: Transaction, inputIndex: number): boolean {
  const input = tx.inputs[inputIndex]
  const source = input.sourceTransaction!.outputs[input.sourceOutputIndex]
  return new Spend({
    sourceTXID: input.sourceTransaction!.id('hex'),
    sourceOutputIndex: input.sourceOutputIndex,
    sourceSatoshis: source.satoshis!,
    lockingScript: source.lockingScript,
    transactionVersion: tx.version,
    otherInputs: tx.inputs.filter((_, index) => index !== inputIndex),
    outputs: tx.outputs,
    inputIndex,
    unlockingScript: input.unlockingScript!,
    inputSequence: input.sequence ?? 0xffffffff,
    lockTime: tx.lockTime
  }).validate()
}

/**
 * The wallet beneath the permissions manager: real BRC-42 keys from a ProtoWallet,
 * an in-memory output store, and two-phase actions that verify every supplied script.
 */
export class FakeWallet {
  readonly proto: ProtoWallet
  readonly identityKey: string
  readonly outputs = new Map<string, StoredOutput>()
  readonly pending = new Map<string, { tx: Transaction; args: CreateActionArgs }>()
  #nextReference = 0

  constructor(key = PrivateKey.fromRandom()) {
    this.proto = new ProtoWallet(key)
    this.identityKey = key.toPublicKey().toString()
  }

  asWallet(): WalletInterface {
    return this as unknown as WalletInterface
  }

  getPublicKey: WalletInterface['getPublicKey'] = async args => await this.proto.getPublicKey(args)
  createSignature: WalletInterface['createSignature'] = async args =>
    await this.proto.createSignature(args)
  verifySignature: WalletInterface['verifySignature'] = async args =>
    await this.proto.verifySignature(args)
  encrypt: WalletInterface['encrypt'] = async args => await this.proto.encrypt(args)
  decrypt: WalletInterface['decrypt'] = async args => await this.proto.decrypt(args)

  store(tx: Transaction, vout: number, basket: string, customInstructions?: string): void {
    this.outputs.set(`${tx.id('hex')}.${vout}`, {
      tx,
      vout,
      basket,
      customInstructions,
      spent: false
    })
  }

  async listOutputs(args: ListOutputsArgs): Promise<ListOutputsResult> {
    const inventory = args.basket === toolbox.specOpBasketPrefixOutputs
    const records = [...this.outputs.entries()]
      .filter(([, output]) =>
        inventory
          ? !output.spent && output.basket?.startsWith(`${args.tags?.[0]} `) === true
          : !output.spent && output.reservedBy === undefined && output.basket === args.basket
      )
      .sort(([a], [b]) => (a < b ? -1 : 1))
    const offset = args.offset ?? 0
    const page = inventory ? records : records.slice(offset, offset + (args.limit ?? 10))
    const beef = new Beef()
    const result: ListOutputsResult = {
      totalOutputs: records.length,
      outputs: page.map(([outpoint, output]) => {
        if (args.include === 'entire transactions') beef.mergeTransaction(output.tx)
        return {
          outpoint,
          satoshis: output.tx.outputs[output.vout].satoshis!,
          spendable: output.reservedBy === undefined,
          lockingScript:
            args.include === 'locking scripts'
              ? output.tx.outputs[output.vout].lockingScript.toHex()
              : undefined,
          customInstructions:
            args.includeCustomInstructions === true ? output.customInstructions : undefined,
          tags: args.includeTags === true ? [] : undefined
        }
      })
    }
    if (args.include === 'entire transactions') result.BEEF = beef.toBinary()
    return result
  }

  async createAction(args: CreateActionArgs): Promise<CreateActionResult> {
    const tx = new Transaction()
    const reference = `reference-${this.#nextReference++}`
    for (const input of args.inputs ?? []) {
      const stored = this.outputs.get(input.outpoint)
      if (stored === undefined || stored.spent || stored.reservedBy !== undefined) {
        throw new Error(`input ${input.outpoint} is not available`)
      }
      stored.reservedBy = reference
      tx.addInput({
        sourceTransaction: stored.tx,
        sourceOutputIndex: stored.vout,
        unlockingScript: new UnlockingScript()
      })
    }
    for (const output of args.outputs ?? []) {
      tx.addOutput({
        lockingScript: LockingScript.fromHex(output.lockingScript),
        satoshis: output.satoshis
      })
    }
    this.pending.set(reference, { tx, args })
    return { signableTransaction: { tx: tx.toAtomicBEEF(), reference } }
  }

  async signAction(args: SignActionArgs): Promise<SignActionResult> {
    const pending = this.pending.get(args.reference)
    if (pending === undefined) throw new Error('unknown reference')
    for (const [index, spend] of Object.entries(args.spends ?? {})) {
      pending.tx.inputs[Number(index)].unlockingScript = UnlockingScript.fromHex(
        spend.unlockingScript
      )
      if (!validInput(pending.tx, Number(index))) throw new Error(`input ${index} does not unlock`)
    }
    this.pending.delete(args.reference)
    for (const input of pending.args.inputs ?? []) this.outputs.get(input.outpoint)!.spent = true
    pending.args.outputs?.forEach((output, vout) => {
      if (output.basket !== undefined)
        this.store(pending.tx, vout, output.basket, output.customInstructions)
    })
    return { txid: pending.tx.id('hex'), tx: pending.tx.toAtomicBEEF() }
  }

  async abortAction(args: { reference: string }): Promise<{ aborted: true }> {
    this.pending.delete(args.reference)
    for (const output of this.outputs.values())
      if (output.reservedBy === args.reference) output.reservedBy = undefined
    return { aborted: true }
  }

  async internalizeAction(args: InternalizeActionArgs): Promise<{ accepted: true }> {
    const tx = Transaction.fromAtomicBEEF(args.tx)
    for (const output of args.outputs) {
      const remittance = output.insertionRemittance
      if (remittance !== undefined)
        this.store(tx, output.outputIndex, remittance.basket, remittance.customInstructions)
    }
    return { accepted: true }
  }
}

/** An overlay provider that admits whatever token outputs it is given. */
export class FakeProvider {
  readonly current = new Map<string, { assetId: string; tx: Transaction; vout: number }>()
  readonly history = new Map<string, { assetId: string; tx: Transaction; vout: number }>()
  readonly submissions: Array<{ assetIds: string[]; txid: string }> = []
  rejectSubmissions = false

  admit(assetId: string, tx: Transaction, vout: number): void {
    const entry = { assetId, tx, vout }
    this.current.set(`${tx.id('hex')}.${vout}`, entry)
    this.history.set(`${tx.id('hex')}.${vout}`, entry)
  }

  spend(outpoint: string): void {
    this.current.delete(outpoint)
  }

  spendability = async (assetId: string, outpoints: string[]): Promise<LookupAnswer> =>
    this.#answer(this.current, assetId, outpoints)

  admission = async (assetId: string, outpoints: string[]): Promise<LookupAnswer> =>
    this.#answer(this.history, assetId, outpoints)

  submit = async (assetIds: string[], beef: number[]): Promise<STEAK> => {
    const tx = Transaction.fromAtomicBEEF(beef)
    const txid = tx.id('hex')
    this.submissions.push({ assetIds, txid })
    for (const input of tx.inputs)
      this.spend(`${input.sourceTransaction!.id('hex')}.${input.sourceOutputIndex}`)
    const steak: STEAK = {}
    for (const assetId of assetIds) {
      const outputsToAdmit = this.rejectSubmissions
        ? []
        : tx.outputs.flatMap((output, vout) =>
            readTokenOutput(output.lockingScript, { txid, vout })?.assetId === assetId ? [vout] : []
          )
      for (const vout of outputsToAdmit) this.admit(assetId, tx, vout)
      steak[colorTopic(assetId)] = { outputsToAdmit, coinsToRetain: [] }
    }
    return steak
  }

  #answer(
    entries: Map<string, { assetId: string; tx: Transaction; vout: number }>,
    assetId: string,
    outpoints: string[]
  ): LookupAnswer {
    return {
      type: 'output-list',
      outputs: outpoints.flatMap(outpoint => {
        const entry = entries.get(outpoint)
        return entry?.assetId === assetId
          ? [{ beef: entry.tx.toBEEF(), outputIndex: entry.vout }]
          : []
      })
    }
  }
}

export function remittanceString(): string {
  return toBase64(Random(16))
}

/** Deploys a fixed-supply asset to `issuer`, held in its value basket, and admits the deploy. */
export async function deployAsset(
  issuer: FakeWallet,
  provider: FakeProvider,
  amount: bigint,
  payload?: number[]
): Promise<{ assetId: string; tx: Transaction }> {
  const custody = {
    derivationPrefix: remittanceString(),
    derivationSuffix: remittanceString(),
    senderIdentityKey: issuer.identityKey
  }
  const { publicKey } = await issuer.getPublicKey({
    protocolID: colorProtocolID(ISSUE, custody.derivationPrefix, custody.derivationSuffix),
    keyID: COLOR_KEY_ID,
    counterparty: issuer.identityKey,
    forSelf: true
  })
  const tx = new Transaction()
  tx.addOutput({
    lockingScript: new OneColor().lock(null, amount, hash160(toArray(publicKey, 'hex')), payload),
    satoshis: 1000
  })
  const assetId = `${tx.id('hex')}_0`
  provider.admit(assetId, tx, 0)
  issuer.store(
    tx,
    0,
    assetBasket(assetId, 'value'),
    JSON.stringify({ version: 1, assetId: ISSUE, ...custody })
  )
  return { assetId, tx }
}

/** A transaction paying `amount` of an asset to `recipient`, keyed by `sender` as BRC-207 specifies. */
export async function tokenPayment(
  sender: FakeWallet,
  recipient: FakeWallet,
  assetId: string,
  amount: bigint
): Promise<{ tx: Transaction; customInstructions: string }> {
  const custody = {
    version: 1,
    assetId,
    derivationPrefix: remittanceString(),
    derivationSuffix: remittanceString(),
    senderIdentityKey: sender.identityKey
  }
  const { publicKey } = await sender.getPublicKey({
    protocolID: colorProtocolID(assetId, custody.derivationPrefix, custody.derivationSuffix),
    keyID: COLOR_KEY_ID,
    counterparty: recipient.identityKey
  })
  const tx = new Transaction()
  tx.addOutput({
    lockingScript: new OneColor().lock(assetId, amount, hash160(toArray(publicKey, 'hex'))),
    satoshis: 1000
  })
  return { tx, customInstructions: JSON.stringify(custody) }
}

/** Gives `holder` admitted outputs of each amount, as completed receipts. */
export async function holdTokens(
  holder: FakeWallet,
  provider: FakeProvider,
  assetId: string,
  amounts: bigint[]
): Promise<Transaction[]> {
  const sender = new FakeWallet()
  const txs: Transaction[] = []
  for (const amount of amounts) {
    const { tx, customInstructions } = await tokenPayment(sender, holder, assetId, amount)
    provider.admit(assetId, tx, 0)
    holder.store(tx, 0, assetBasket(assetId, 'value'), customInstructions)
    txs.push(tx)
  }
  return txs
}

export function createModule(
  wallet: FakeWallet,
  provider: FakeProvider,
  requestTokenAccess = async (_app: string, _message: string): Promise<boolean> => true
): ColorPermissionModule {
  return new ColorPermissionModule({ wallet: wallet.asWallet(), provider, requestTokenAccess })
}
