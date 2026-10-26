import {
  Beef,
  LockingScript,
  OP,
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
import { toArray, toBase64, toHex } from '@bsv/sdk/primitives/utils'
import { OneColor } from '@bsv/templates'
import { sdk as toolbox } from '@bsv/wallet-toolbox-client'
import { ColorPermissionModule } from '../ColorPermissionModule.js'
import {
  assetBasket,
  COLOR_KEY_ID,
  colorProtocolID,
  derivationSuffixTag,
  DISCOVERY_TOPIC,
  ISSUE
} from '../identifiers.js'
import { readAnyTokenOutput } from '../tokenOutputs.js'

interface StoredOutput {
  tx: Transaction
  vout: number
  basket?: string
  customInstructions?: string
  reservedBy?: string
  spent: boolean
  tags?: string[]
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
  /** Every listOutputs call, in order. */
  readonly listOutputsCalls: ListOutputsArgs[] = []
  /**
   * When set, createAction requires every input's source transaction in `inputBEEF`, as
   * wallet-toolbox does when it builds the signable transaction.
   */
  requireInputBEEF = true
  /**
   * Leaves outputs reserved by a pending action out of every listing, as wallet-toolbox's
   * `auto` action-batch workspace does.
   */
  hideReserved = false
  /** Edits the BEEF a listOutputs result returns, to model incomplete storage. */
  editBEEF?: (beef: Beef) => Beef | undefined
  #nextReference = 0

  constructor(key = PrivateKey.fromRandom()) {
    this.proto = new ProtoWallet(key)
    this.identityKey = key.toPublicKey().toString()
  }

  asWallet(): WalletInterface {
    return this as unknown as WalletInterface
  }

  getPublicKey: WalletInterface['getPublicKey'] = async args => await this.proto.getPublicKey(args)

  getVersion: WalletInterface['getVersion'] = async () => ({ version: 'fake-1.0.0' })
  createSignature: WalletInterface['createSignature'] = async args =>
    await this.proto.createSignature(args)
  verifySignature: WalletInterface['verifySignature'] = async args =>
    await this.proto.verifySignature(args)
  encrypt: WalletInterface['encrypt'] = async args => await this.proto.encrypt(args)
  decrypt: WalletInterface['decrypt'] = async args => await this.proto.decrypt(args)

  store(
    tx: Transaction,
    vout: number,
    basket?: string,
    customInstructions?: string,
    tags?: string[]
  ): void {
    this.outputs.set(`${tx.id('hex')}.${vout}`, {
      tx,
      vout,
      basket,
      customInstructions,
      spent: false,
      tags
    })
  }

  async listOutputs(args: ListOutputsArgs): Promise<ListOutputsResult> {
    this.listOutputsCalls.push(args)
    const inventory = args.basket === toolbox.specOpBasketPrefixOutputs
    const records = [...this.outputs.entries()]
      .filter(([, output]) =>
        inventory
          ? !output.spent &&
            output.basket?.startsWith(`${args.tags?.[0]} `) === true &&
            !(this.hideReserved && output.reservedBy !== undefined)
          : !output.spent &&
            output.reservedBy === undefined &&
            output.basket === args.basket &&
            (args.tags === undefined ||
              args.tags.length === 0 ||
              args.tags.some(tag => output.tags?.includes(tag) === true))
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
          tags: args.includeTags === true ? (output.tags ?? []) : undefined
        }
      })
    }
    if (args.include === 'entire transactions')
      result.BEEF = (this.editBEEF === undefined ? beef : this.editBEEF(beef))?.toBinary()
    return result
  }

  async createAction(args: CreateActionArgs): Promise<CreateActionResult> {
    if (this.requireInputBEEF) {
      const beef = args.inputBEEF === undefined ? new Beef() : Beef.fromBinary(args.inputBEEF)
      for (const input of args.inputs ?? []) {
        const found = beef.findTxid(input.outpoint.split('.')[0])
        if (found === undefined || found.isTxidOnly)
          throw new Error('Every signableTransaction input must have a sourceTransaction')
      }
    }
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
      this.store(pending.tx, vout, output.basket, output.customInstructions, output.tags)
    })
    return { txid: pending.tx.id('hex'), tx: pending.tx.toAtomicBEEF() }
  }

  async abortAction(args: { reference: string }): Promise<{ aborted: true }> {
    this.pending.delete(args.reference)
    for (const output of this.outputs.values())
      if (output.reservedBy === args.reference) output.reservedBy = undefined
    return { aborted: true }
  }

  /**
   * As the toolbox: an insertion for an output the wallet already holds is merged (basket and
   * custody assigned, tags left as they are); one for a new output is stored with its tags.
   */
  async internalizeAction(args: InternalizeActionArgs): Promise<{ accepted: true }> {
    const tx = Transaction.fromAtomicBEEF(args.tx)
    for (const output of args.outputs) {
      const remittance = output.insertionRemittance
      if (remittance === undefined) continue
      const held = this.outputs.get(`${tx.id('hex')}.${output.outputIndex}`)
      this.store(
        tx,
        output.outputIndex,
        remittance.basket,
        remittance.customInstructions,
        held === undefined ? remittance.tags : held.tags
      )
    }
    return { accepted: true }
  }
}

/** An overlay provider that admits whatever token outputs it is given. */
export class FakeProvider {
  readonly current = new Map<string, { assetId: string; tx: Transaction; vout: number }>()
  readonly history = new Map<string, { assetId: string; tx: Transaction; vout: number }>()
  readonly submissions: Array<{ topics: string[]; txid: string }> = []
  rejectSubmissions = false

  admit(assetId: string, tx: Transaction, vout: number): void {
    const entry = { assetId, tx, vout }
    this.current.set(`${tx.id('hex')}.${vout}`, entry)
    this.history.set(`${tx.id('hex')}.${vout}`, entry)
  }

  /** Spent outputs are never admitted again. */
  readonly spent = new Set<string>()

  spend(outpoint: string): void {
    this.current.delete(outpoint)
    this.spent.add(outpoint)
  }

  spendability = async (assetId: string, outpoints: string[]): Promise<LookupAnswer> =>
    this.#answer(this.current, assetId, outpoints)

  admission = async (assetId: string, outpoints: string[]): Promise<LookupAnswer> =>
    this.#answer(this.history, assetId, outpoints)

  /** Seeds a deploy's asset overlay from the discovery topic, as a configured provider would. */
  seedDeploys = true

  submit = async (topics: string[], beef: number[]): Promise<STEAK> => {
    const tx = Transaction.fromAtomicBEEF(beef)
    const txid = tx.id('hex')
    this.submissions.push({ topics, txid })
    for (const input of tx.inputs)
      this.spend(`${input.sourceTransaction!.id('hex')}.${input.sourceOutputIndex}`)
    const steak: STEAK = {}
    for (const topic of topics) {
      const assetId = topic === DISCOVERY_TOPIC ? `${txid}_0` : topic.slice('tm_color_'.length)
      const outputsToAdmit = this.rejectSubmissions
        ? []
        : tx.outputs.flatMap((output, vout) =>
            readAnyTokenOutput(output.lockingScript, { txid, vout })?.assetId === assetId
              ? [vout]
              : []
          )
      if (topic !== DISCOVERY_TOPIC || this.seedDeploys)
        for (const vout of outputsToAdmit)
          if (!this.spent.has(`${txid}.${vout}`)) this.admit(assetId, tx, vout)
      steak[topic] = { outputsToAdmit, coinsToRetain: [] }
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

/**
 * A BRC-161 JSON token output: an `ord` inscription of type `application/bsv-20` carrying
 * `payload`, followed by `rest` (anyone can spend it by default).
 */
export function jsonTokenScript(
  payload: object,
  rest = LockingScript.fromASM('OP_TRUE'),
  envelopeFirst = true
): LockingScript {
  const script = new LockingScript()
    .writeOpCode(OP.OP_FALSE)
    .writeOpCode(OP.OP_IF)
    .writeBin(toArray('ord', 'utf8'))
    .writeOpCode(OP.OP_1)
    .writeBin(toArray('application/bsv-20', 'utf8'))
    .writeOpCode(OP.OP_FALSE)
    .writeBin(toArray(JSON.stringify(payload), 'utf8'))
    .writeOpCode(OP.OP_ENDIF)
  return new LockingScript(
    envelopeFirst ? [...script.chunks, ...rest.chunks] : [...rest.chunks, ...script.chunks]
  )
}

export function remittanceString(): string {
  return toBase64(Random(16))
}

/** Deploys an asset to `issuer`, held in its value basket (or authority basket for amount 0), and admits the deploy. */
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
    assetBasket(assetId, amount === 0n ? 'authority' : 'value'),
    JSON.stringify({ version: 1, assetId: ISSUE, ...custody }),
    [derivationSuffixTag(custody.derivationSuffix)]
  )
  return { assetId, tx }
}

/** A transaction paying `amount` of an asset to `recipient`, keyed by `sender` as BRC-207 specifies. */
/** A BRC-161 JSON deploy+mint at output `vout`, admitted to its asset's overlay. */
export function legacyDeploy(provider: FakeProvider, vout: number): string {
  const push = (bytes: number[]): string =>
    bytes.length.toString(16).padStart(2, '0') + toHex(bytes)
  const json = toArray('{"p":"bsv-20","op":"deploy+mint","amt":"1000","dec":"0"}', 'utf8')
  const script =
    '0063' +
    push(toArray('ord', 'utf8')) +
    '51' +
    push(toArray('application/bsv-20', 'utf8')) +
    '00' +
    push(json) +
    '68' +
    '76a914' +
    '11'.repeat(20) +
    '88ac'
  const tx = new Transaction()
  for (let i = 0; i < vout; i++)
    tx.addOutput({ lockingScript: LockingScript.fromHex('51'), satoshis: 1 })
  tx.addOutput({ lockingScript: LockingScript.fromHex(script), satoshis: 1 })
  const assetId = `${tx.id('hex')}_${vout}`
  provider.admit(assetId, tx, vout)
  return assetId
}

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
  // The payment spends an anyone-can-spend source of the same amount, so it is a valid transfer.
  const prefix = new OneColor().lock(assetId, amount, Array(20).fill(0)).chunks.slice(0, 3)
  const source = new Transaction()
  source.addOutput({
    lockingScript: new LockingScript([...prefix, { op: OP.OP_TRUE }]),
    satoshis: 1000
  })
  const tx = new Transaction()
  tx.addInput({
    sourceTransaction: source,
    sourceOutputIndex: 0,
    unlockingScript: new UnlockingScript()
  })
  tx.addOutput({
    lockingScript: new OneColor().lock(assetId, amount, hash160(toArray(publicKey, 'hex'))),
    satoshis: 1000
  })
  return { tx, customInstructions: JSON.stringify(custody) }
}

/**
 * Gives `holder` admitted outputs of each amount (0 for an authority), as completed receipts filed
 * with their suffix tag, or untagged as filed before suffix tags.
 */
export async function holdTokens(
  holder: FakeWallet,
  provider: FakeProvider,
  assetId: string,
  amounts: bigint[],
  tagged = true
): Promise<Transaction[]> {
  const sender = new FakeWallet()
  const txs: Transaction[] = []
  for (const amount of amounts) {
    const { tx, customInstructions } = await tokenPayment(sender, holder, assetId, amount)
    provider.admit(assetId, tx, 0)
    const { derivationSuffix } = JSON.parse(customInstructions) as { derivationSuffix: string }
    holder.store(
      tx,
      0,
      assetBasket(assetId, amount === 0n ? 'authority' : 'value'),
      customInstructions,
      tagged ? [derivationSuffixTag(derivationSuffix)] : undefined
    )
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
