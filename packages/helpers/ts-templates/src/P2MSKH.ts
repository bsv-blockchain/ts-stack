import { ScriptTemplate, LockingScript, UnlockingScript, OP, Hash, PublicKey, TransactionSignature, Signature, Utils, WalletInterface, Transaction, ScriptChunk } from '@bsv/sdk'

export interface MultiSigInstructions {
  keyID: string
  counterparty: string
  pubkeys: string[]
}

function concatPubkeys (pubkeys: PublicKey[]): number[] {
  return pubkeys.map((p) => p.toDER() as number[]).reduce((a, b) => a.concat(b), [])
}

function numberFromScriptChunk (chunk: ScriptChunk): number {
  let returnNum: number
  if (chunk.data == null) {
    returnNum = 1 + (chunk.op) - OP.OP_1
  } else {
    const reader = new Utils.Reader(chunk.data)
    const threshold = reader.readInt64LEBn()
    returnNum = threshold.toNumber()
  }
  return returnNum
}

export class P2MSKH implements ScriptTemplate {
  static address (pubkeys: PublicKey[], threshold: number): string {
    if (threshold < 1 || threshold > pubkeys.length) throw new Error('threshold must be between 1 and the number of pubkeys')
    if (!pubkeys || pubkeys.length < 2 || pubkeys.length < threshold) throw new Error(`at least ${threshold || 2} pubkeys are required`)
    const concat = concatPubkeys(pubkeys)
    const hash = Hash.hash160(concat)
    const writer = new Utils.Writer()
    writer.write(hash)
    writer.writeVarIntNum(threshold)
    writer.writeVarIntNum(pubkeys.length)
    const data = writer.toArray()
    return Utils.toBase58Check(data, [0x98])
  }

  static async addressBRC29 (wallet: WalletInterface, counterparties: string[], keyID: string, threshold: number): Promise<{ pubkeys: string[], address: string }> {
    const pubkeys = await Promise.all(counterparties.map(async (counterparty) => {
      const { publicKey } = await wallet.getPublicKey({
        protocolID: [1, 'multi sig brc29'],
        keyID,
        counterparty
      })
      return PublicKey.fromString(publicKey)
    }))
    return { pubkeys: pubkeys.map(p => p.toString()), address: this.address(pubkeys, threshold) }
  }

  static thresholdAndTotalFromAddress (address: string): { hash: number[], threshold: number, total: number } {
    const h = Utils.fromBase58Check(address)
    if (h.prefix[0] !== 0x98) {
      throw new Error('only P2MSH is supported, set your prefix byte to 0x98')
    }
    const reader = new Utils.Reader(h.data as number[])
    const hash = reader.read(20)
    const threshold = reader.readVarIntNum()
    const total = reader.readVarIntNum()
    return { hash, threshold, total }
  }

  lock (
    address?: string,
    pubkeys?: PublicKey[],
    threshold: number = 1
  ): LockingScript {
    let hash: number[]
    let total: number = pubkeys?.length || 0
    if (address) {
      if (typeof address !== 'string') throw new Error('address must be a string')
      const result = P2MSKH.thresholdAndTotalFromAddress(address)
      hash = result.hash
      total = result.total
      threshold = result.threshold
    } else {
      if ((pubkeys == null) || total < 2) throw new Error('at least 2 pubkeys are required')
      const concat = concatPubkeys(pubkeys)
      hash = Hash.hash160(concat)
    }
    if (!threshold || threshold < 1 || threshold > total) throw new Error('threshold must be between 1 and the number of pubkeys')
    if (total > 10) throw new Error('total must be less than or equal to 10')

    const script = new LockingScript()
    script
      .writeOpCode(OP.OP_DUP)
      .writeOpCode(OP.OP_HASH160)
      .writeBin(hash)
      .writeOpCode(OP.OP_EQUALVERIFY)
      .writeNumber(threshold)
      .writeOpCode(OP.OP_SWAP)
    for (let i = 0; i < total - 1; i++) {
      script
        .writeNumber(33)
        .writeOpCode(OP.OP_SPLIT)
    }
    script.writeNumber(total)
    script.writeOpCode(OP.OP_CHECKMULTISIG)

    return script
  }

  unlock (
    wallet: WalletInterface,
    customInstructions: MultiSigInstructions,
    workingUnlockingScript?: UnlockingScript,
    signOutputs: 'all' | 'none' | 'single' = 'all',
    anyoneCanPay = false,
    sourceSatoshis?: number,
    lockingScript?: LockingScript
  ): {
      sign: (tx: Transaction, inputIndex: number) => Promise<UnlockingScript>
      estimateLength: (tx: Transaction, inputIndex: number) => Promise<number>
    } {
    return {
      sign: async (tx: Transaction, inputIndex: number) => {
        if (workingUnlockingScript == null) {
          workingUnlockingScript = new UnlockingScript()
          workingUnlockingScript.writeOpCode(OP.OP_0)
          const pubkeys = concatPubkeys(customInstructions.pubkeys.map(p => PublicKey.fromString(p)))
          workingUnlockingScript.writeBin(pubkeys)
        }

        let signatureScope = TransactionSignature.SIGHASH_FORKID
        if (signOutputs === 'all') {
          signatureScope |= TransactionSignature.SIGHASH_ALL
        }
        if (signOutputs === 'none') {
          signatureScope |= TransactionSignature.SIGHASH_NONE
        }
        if (signOutputs === 'single') {
          signatureScope |= TransactionSignature.SIGHASH_SINGLE
        }
        if (anyoneCanPay) {
          signatureScope |= TransactionSignature.SIGHASH_ANYONECANPAY
        }
        const input = tx.inputs[inputIndex]

        const otherInputs = tx.inputs.filter(
          (_, index) => index !== inputIndex
        )

        const sourceTXID = input.sourceTXID
          ? input.sourceTXID
          : input.sourceTransaction?.id('hex')

        if (!sourceTXID) {
          throw new Error(
            'The input sourceTXID or sourceTransaction is required for transaction signing.'
          )
        }
        sourceSatoshis ||= input.sourceTransaction?.outputs[input.sourceOutputIndex].satoshis
        if (!sourceSatoshis) {
          throw new Error(
            'The sourceSatoshis or input sourceTransaction is required for transaction signing.'
          )
        }
        lockingScript ||= input.sourceTransaction?.outputs[input.sourceOutputIndex].lockingScript
        if (lockingScript == null) {
          throw new Error(
            'The lockingScript or input sourceTransaction is required for transaction signing.'
          )
        }

        const preimage = TransactionSignature.format({
          sourceTXID,
          sourceOutputIndex: input.sourceOutputIndex,
          sourceSatoshis,
          transactionVersion: tx.version,
          otherInputs,
          inputIndex,
          outputs: tx.outputs,
          inputSequence: input.sequence || 0xffffffff,
          subscript: lockingScript,
          lockTime: tx.lockTime,
          scope: signatureScope
        })

        const hashToDirectlySign = Hash.hash256(preimage)

        const { signature } = await wallet.createSignature({
          hashToDirectlySign,
          protocolID: [1, 'multi sig brc29'],
          counterparty: customInstructions.counterparty,
          keyID: customInstructions.keyID
        })

        const s = Signature.fromDER(signature)
        const sig = new TransactionSignature(s.r, s.s, signatureScope)
        const sigForScript = sig.toChecksigFormat()

        workingUnlockingScript.writeBin(sigForScript)
        const chunkforSig = workingUnlockingScript.chunks.pop() as ScriptChunk
        // add it to the array before the pubkeys, pushing the other content to the right
        workingUnlockingScript.chunks.splice(workingUnlockingScript.chunks.length - 1, 0, chunkforSig)
        return workingUnlockingScript
      },

      estimateLength: async (tx: Transaction, inputIndex: number) => {
        let numberOfPubkeys
        let numberOfSignatures
        const staticLength = 8
        const input = tx.inputs[inputIndex]
        const lockingScript = input.sourceTransaction?.outputs[input.sourceOutputIndex].lockingScript
        if (lockingScript == null) {
          return await Promise.resolve(1000) // guess
        }

        const totalChunk = lockingScript.chunks.at(-2) as { op: number, data: number[] }
        numberOfPubkeys = numberFromScriptChunk(totalChunk)

        const thresholdChunk = lockingScript.chunks[4] as { op: number, data: number[] }
        numberOfSignatures = numberFromScriptChunk(thresholdChunk)
        return await Promise.resolve(staticLength + (numberOfSignatures * 74) + (numberOfPubkeys * 34))
      }
    }
  }
}
