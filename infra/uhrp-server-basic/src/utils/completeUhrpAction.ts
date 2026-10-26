import {
  Transaction,
  type CreateActionArgs,
  type UnlockingScript,
  type WalletInterface
} from '@bsv/sdk'

const MAX_TRANSACTION_BYTES = 256 * 1024 * 1024

function bytes(value: unknown): number[] | Uint8Array {
  if (value instanceof Uint8Array) {
    if (value.length < 1 || value.length > MAX_TRANSACTION_BYTES) throw new Error('Wallet transaction is invalid')
    return value
  }
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_TRANSACTION_BYTES) {
    throw new Error('Wallet transaction is invalid')
  }
  for (let index = 0; index < value.length; index++) {
    if (!Number.isInteger(value[index]) || value[index] < 0 || value[index] > 255) {
      throw new Error('Wallet transaction is invalid')
    }
  }
  return value as number[]
}

function inputOutpoint(transaction: Transaction, index: number): string {
  const input = transaction.inputs[index]
  const txid = input.sourceTXID ?? input.sourceTransaction?.id('hex')
  if (
    typeof txid !== 'string' ||
    !/^[0-9a-f]{64}$/i.test(txid) ||
    !Number.isSafeInteger(input.sourceOutputIndex) ||
    input.sourceOutputIndex < 0 ||
    input.sourceOutputIndex > 0xffffffff
  ) {
    throw new Error('Wallet transaction input is invalid')
  }
  if (
    input.sourceTXID !== undefined &&
    input.sourceTransaction !== undefined &&
    input.sourceTransaction.id('hex').toLowerCase() !== input.sourceTXID.toLowerCase()
  ) {
    throw new Error('Wallet transaction input source is inconsistent')
  }
  return `${txid.toLowerCase()}.${input.sourceOutputIndex}`
}

function sameTemplate(partial: Transaction, signed: Transaction): boolean {
  if (
    partial.version !== signed.version ||
    partial.lockTime !== signed.lockTime ||
    partial.inputs.length !== signed.inputs.length ||
    partial.outputs.length !== signed.outputs.length
  ) return false
  for (let index = 0; index < partial.inputs.length; index++) {
    if (
      inputOutpoint(partial, index) !== inputOutpoint(signed, index) ||
      (partial.inputs[index].sequence ?? 0xffffffff) !==
        (signed.inputs[index].sequence ?? 0xffffffff)
    ) return false
  }
  return partial.outputs.every((output, index) =>
    output.satoshis === signed.outputs[index].satoshis &&
    output.lockingScript.toHex() === signed.outputs[index].lockingScript.toHex()
  )
}

async function abort(wallet: WalletInterface, reference: string): Promise<void> {
  try {
    await wallet.abortAction({ reference })
  } catch {
    // Preserve the security failure that caused the abort.
  }
}

/** Complete the UHRP service's zero- or one-custom-input action with exact binding. */
export async function completeUhrpAction(
  wallet: WalletInterface,
  args: CreateActionArgs,
  signer?: {
    outpoint: string
    sign: (transaction: Transaction, inputIndex: number) => Promise<UnlockingScript>
  }
): Promise<Transaction> {
  if ((args.inputs?.length ?? 0) > 1 || ((args.inputs?.length ?? 0) === 1) !== (signer !== undefined)) {
    throw new Error('UHRP action signer configuration is invalid')
  }
  if (signer !== undefined && args.inputs?.[0]?.outpoint.toLowerCase() !== signer.outpoint.toLowerCase()) {
    throw new Error('UHRP action signer does not match its requested input')
  }
  const result = await wallet.createAction({
    ...args,
    options: { ...args.options, signAndProcess: false, returnTXIDOnly: false }
  })
  const signable = result.signableTransaction
  if (
    signable == null || typeof signable.reference !== 'string' ||
    signable.reference.length < 1 || signable.reference.length > 4096
  ) {
    throw new Error('Wallet did not return a signable UHRP transaction')
  }
  try {
    const partial = Transaction.fromAtomicBEEF(bytes(signable.tx))
    for (const requested of args.outputs ?? []) {
      const matches = partial.outputs.filter(output =>
        output.satoshis === requested.satoshis &&
        output.lockingScript.toHex().toLowerCase() === requested.lockingScript.toLowerCase()
      )
      if (matches.length !== 1) throw new Error('Wallet substituted a requested UHRP output')
    }
    const spends: Record<number, { unlockingScript: string }> = {}
    let expectedUnlockingScript: string | undefined
    let signedInputIndex: number | undefined
    if (signer !== undefined) {
      const indexes = partial.inputs.flatMap((_, index) =>
        inputOutpoint(partial, index) === signer.outpoint.toLowerCase() ? [index] : []
      )
      if (indexes.length !== 1) throw new Error('Wallet substituted the requested UHRP input')
      signedInputIndex = indexes[0]
      if (
        (partial.inputs[signedInputIndex].sequence ?? 0xffffffff) !==
        (args.inputs?.[0]?.sequenceNumber ?? 0xffffffff)
      ) {
        throw new Error('Wallet substituted the requested UHRP input sequence')
      }
      expectedUnlockingScript = (await signer.sign(partial, signedInputIndex)).toHex().toLowerCase()
      spends[signedInputIndex] = { unlockingScript: expectedUnlockingScript }
    }
    const signedResult = await wallet.signAction({ reference: signable.reference, spends })
    const signed = Transaction.fromAtomicBEEF(bytes(signedResult.tx))
    if (!sameTemplate(partial, signed)) throw new Error('Wallet substituted the signed UHRP transaction')
    if (
      signedInputIndex !== undefined &&
      signed.inputs[signedInputIndex].unlockingScript?.toHex().toLowerCase() !== expectedUnlockingScript
    ) {
      throw new Error('Wallet substituted the authorized UHRP unlocking script')
    }
    if (
      signedResult.txid !== undefined &&
      (typeof signedResult.txid !== 'string' ||
        signedResult.txid.toLowerCase() !== signed.id('hex').toLowerCase())
    ) {
      throw new Error('Wallet returned a foreign UHRP transaction ID')
    }
    return signed
  } catch (error) {
    await abort(wallet, signable.reference)
    throw error
  }
}
