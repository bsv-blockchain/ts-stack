import { AuthFetch, PrivateKey, ProtoWallet, Script, Transaction } from '@bsv/sdk'

// This code runs in an actual cross-origin browser without Node globals.
globalThis.pay = async ({ origin, ancestorBytes, contentType, body, legacy = false }) => {
  const wallet = new ProtoWallet(new PrivateKey(24))
  let prepared = 0
  let submitted = 0
  let aborted = 0
  wallet.abortAction = async () => {
    aborted++
    return { aborted: true }
  }
  wallet.createAction = async args => {
    if (args.options?.sendWith !== undefined) {
      submitted++
      return { sendWithResults: args.options.sendWith.map(txid => ({ txid, status: 'unproven' })) }
    }
    if (legacy) submitted++
    else {
      prepared++
      if (args.options?.noSend !== true)
        throw new Error('Payment was not prepared before submission')
    }
    const source = new Transaction()
    source.addOutput({ satoshis: 1000, lockingScript: Script.fromASM('OP_TRUE') })
    if (ancestorBytes > 0)
      source.addOutput({
        satoshis: 0,
        lockingScript: Script.fromASM(`OP_FALSE OP_RETURN ${'01'.repeat(ancestorBytes)}`)
      })
    const tx = new Transaction()
    tx.addInput({
      sourceTransaction: source,
      sourceOutputIndex: 0,
      unlockingScript: Script.fromASM('OP_TRUE')
    })
    tx.addOutput({
      satoshis: args.outputs[0].satoshis,
      lockingScript: Script.fromHex(args.outputs[0].lockingScript)
    })
    return { txid: tx.id('hex'), tx: tx.toAtomicBEEF() }
  }
  const challenges = []
  const client = new AuthFetch(wallet, undefined, undefined, undefined, {}, async (url, init) => {
    const response = await fetch(url, init)
    if (response.status === 402) challenges.push(response.headers.get('x-bsv-payment-transports'))
    return response
  })
  try {
    const response = await client.fetch(`${origin}/paid`, {
      method: 'POST',
      headers: { 'content-type': contentType },
      body: new Uint8Array(body),
      paymentRetryAttempts: 1
    })
    return {
      status: response.status,
      result: await response.json(),
      prepared,
      submitted,
      aborted,
      challenges
    }
  } catch (error) {
    return { code: error.code, prepared, submitted, aborted, challenges }
  }
}
