import {
  BigNumber,
  Curve,
  ECDSA,
  Hash,
  KeyDeriver,
  MerklePath,
  P2PKH,
  PrivateKey,
  ProtoWallet,
  Script,
  Signature,
  Transaction,
  TransactionSignature
} from '@bsv/sdk'
import BdkVerifier, { BdkErrorDomain } from '../BdkVerifier.js'
import { buildCorpus, spendsForTransaction } from '../../bench/corpus.js'

interface TestBackendGlobal {
  __bsvSdkAsyncCryptoBackendV1?: object
  __bsvSdkScriptVerificationBackendV1?: object
}

function clearDefaultBackends (): void {
  const registry = globalThis as typeof globalThis & TestBackendGlobal
  delete registry.__bsvSdkAsyncCryptoBackendV1
  delete registry.__bsvSdkScriptVerificationBackendV1
}

async function p2pkhTransaction (key: PrivateKey): Promise<Transaction> {
  const source = new Transaction()
  source.addInput({
    sourceTXID: '00'.repeat(32),
    sourceOutputIndex: 0,
    unlockingScript: Script.fromASM('OP_TRUE')
  })
  source.addOutput({
    satoshis: 2,
    lockingScript: new P2PKH().lock(key.toAddress())
  })
  source.merklePath = new MerklePath(777, [
    [{ offset: 0, hash: source.id('hex'), txid: true }, { offset: 1, duplicate: true }]
  ])
  const transaction = new Transaction()
  transaction.addInput({
    sourceTransaction: source,
    sourceOutputIndex: 0,
    unlockingScriptTemplate: new P2PKH().unlock(key)
  })
  transaction.addOutput({
    satoshis: 1,
    lockingScript: new P2PKH().lock(key.toAddress())
  })
  await transaction.sign()
  return transaction
}

describe('bundled BDK WASM in Node', () => {
  afterEach(clearDefaultBackends)

  it('loads without a caller-supplied factory and returns structured results', async () => {
    const verifier = new BdkVerifier({ registerAsDefault: false })
    const corpus = await buildCorpus()
    const valid = corpus.find(({ name }) => name === 'p2pkh-1in-valid')
    const invalid = corpus.find(({ name }) => name === 'p2pkh-corrupt-signature')
    if (valid === undefined || invalid === undefined) throw new Error('required corpus vectors are missing')

    await expect(verifier.verifyScriptsDetailed({
      tx: valid.tx,
      blockHeight: 943816,
      consensus: true
    })).resolves.toEqual({ domain: BdkErrorDomain.OK, code: 0 })

    const invalidResult = await verifier.verifyScriptsDetailed({
      tx: invalid.tx,
      blockHeight: 943816,
      consensus: true
    })
    expect(invalidResult.domain).toBe(BdkErrorDomain.SCRIPT)
    expect(invalidResult.code).not.toBe(0)
  })

  it('validates SDK Spend objects singly and through one packed WASM batch', async () => {
    const verifier = new BdkVerifier({ registerAsDefault: false })
    const corpus = await buildCorpus()
    const selected = corpus.filter(({ name }) =>
      name === 'p2pkh-5in-valid' || name === 'p2pkh-5in-one-corrupt-signature'
    )
    const spends = selected.flatMap(({ tx }) => spendsForTransaction(tx))
    const expected = spends.map(spend => {
      try {
        return spend.validate()
      } catch {
        return false
      }
    })

    await expect(verifier.verifySpend(spends[0])).resolves.toBe(true)
    await expect(verifier.verifySpendsBatch(spends.map(spend => ({ spend })))).resolves.toEqual(expected)
    expect(expected.filter(valid => !valid)).toHaveLength(1)
  })

  it('keeps version-1 strictness identical before and after WASM warm-up', async () => {
    const source = new Transaction()
    source.addInput({
      sourceTXID: '00'.repeat(32),
      sourceOutputIndex: 0,
      unlockingScript: Script.fromASM('OP_TRUE')
    })
    source.addOutput({
      satoshis: 2,
      lockingScript: Script.fromASM('OP_DROP OP_TRUE')
    })
    source.merklePath = new MerklePath(777, [
      [{ offset: 0, hash: source.id('hex'), txid: true }, { offset: 1, duplicate: true }]
    ])
    const tx = new Transaction()
    tx.addInput({
      sourceTransaction: source,
      sourceOutputIndex: 0,
      unlockingScript: Script.fromBinary([0x4c, 0x01, 0x01])
    })
    tx.addOutput({ satoshis: 1, lockingScript: Script.fromASM('OP_TRUE') })

    await expect(tx.verify('scripts only')).rejects.toThrow('not minimally-encoded')

    const verifier = new BdkVerifier({ registerAsDefault: false })
    await verifier.preload()
    expect(verifier.shouldVerifyScripts({
      tx,
      blockHeight: 943816,
      consensus: false
    })).toBe(false)
    await expect(tx.verify('scripts only', undefined, undefined, verifier))
      .rejects.toThrow('not minimally-encoded')

    await expect(verifier.verifyScripts({
      tx,
      blockHeight: 943816,
      consensus: true
    })).resolves.toBe(true)
    await expect(verifier.verifyScripts({
      tx,
      blockHeight: 943816,
      consensus: false
    })).resolves.toBe(false)

    const highSTx = await p2pkhTransaction(new PrivateKey(42))
    const unlockingScript = highSTx.inputs[0].unlockingScript
    if (unlockingScript === undefined) throw new Error('missing signed P2PKH fixture')
    const chunks = unlockingScript.chunks
    const signatureBytes = chunks[0].data
    if (signatureBytes === undefined) throw new Error('missing P2PKH signature')
    const signature = TransactionSignature.fromChecksigFormat(signatureBytes)
    const highSignature = new TransactionSignature(
      signature.r,
      new Curve().n.sub(signature.s),
      signature.scope
    ).toChecksigFormat()
    unlockingScript.chunks = [
      { op: highSignature.length, data: highSignature },
      chunks[1]
    ]

    await expect(highSTx.verify('scripts only')).rejects.toThrow()
    expect(verifier.shouldVerifyScripts({
      tx: highSTx,
      blockHeight: 943816,
      consensus: false
    })).toBe(true)
    await expect(highSTx.verify('scripts only', undefined, undefined, verifier))
      .rejects.toThrow(`Script verification failed for transaction ${highSTx.id('hex')}`)
    await expect(verifier.verifyScripts({
      tx: highSTx,
      blockHeight: 943816,
      consensus: true
    })).resolves.toBe(false)
    await expect(verifier.verifyScripts({
      tx: highSTx,
      blockHeight: 943816,
      consensus: false
    })).resolves.toBe(false)
    verifier.dispose()
  })

  it.each([
    ['ttn', 4],
    ['teratestnet', 4],
    ['terratestnet', 4],
    ['tstn', 5]
  ] as const)('validates through the real %s network path (BDK ID %i)', async (network, _networkId) => {
    const verifier = new BdkVerifier({ network, registerAsDefault: false })
    const valid = (await buildCorpus()).find(({ name }) => name === 'p2pkh-1in-valid')
    if (valid === undefined) throw new Error('required corpus vector is missing')
    await expect(verifier.verifyScripts({
      tx: valid.tx,
      blockHeight: 943816,
      consensus: true
    })).resolves.toBe(true)
  })

  it('matches SDK crypto, BRC-42 derivation, wallet signatures, and P2PKH bytes', async () => {
    const rootKey = new PrivateKey(42)
    const counterparty = new PrivateKey(99).toPublicKey()
    const digest = Uint8Array.from(Hash.sha256([1, 2, 3, 4]))
    const sdkSignature = ECDSA.sign(
      new BigNumber(Array.from(digest)),
      rootKey,
      true
    )
    const baselineTransaction = await p2pkhTransaction(rootKey)
    const baselineWallet = new ProtoWallet(rootKey)
    const signatureArgs = {
      hashToDirectlySign: Array.from(digest),
      protocolID: [2, 'verifast equivalence'] as [2, string],
      keyID: '1',
      counterparty: counterparty.toString()
    }
    const baselineWalletSignature = await baselineWallet.createSignature(signatureArgs)
    const baselineHmac = await baselineWallet.createHmac({
      data: [1, 2, 3],
      protocolID: [2, 'verifast equivalence'],
      keyID: '2',
      counterparty: counterparty.toString()
    })

    const verifier = new BdkVerifier({ batchWorkers: 1 })
    await verifier.preload()

    expect(await verifier.signDigest(
      Uint8Array.from(rootKey.toArray('be', 32)),
      digest
    )).toEqual(Uint8Array.from(sdkSignature.toDER() as number[]))
    expect(await verifier.publicKeyFromPrivate(
      Uint8Array.from(rootKey.toArray('be', 32))
    )).toEqual(Uint8Array.from(rootKey.toPublicKey().encode(true) as number[]))
    expect(await verifier.verifyDigest(
      Uint8Array.from(rootKey.toPublicKey().encode(true) as number[]),
      digest,
      Uint8Array.from(sdkSignature.toDER() as number[])
    )).toBe(true)

    const highSignature = new Signature(
      sdkSignature.r,
      new Curve().n.sub(sdkSignature.s)
    )
    expect(ECDSA.verify(
      new BigNumber(Array.from(digest)),
      highSignature,
      rootKey.toPublicKey()
    )).toBe(true)
    expect(await verifier.verifyDigest(
      Uint8Array.from(rootKey.toPublicKey().encode(true) as number[]),
      digest,
      Uint8Array.from(highSignature.toDER() as number[])
    )).toBe(true)

    const keyDeriver = new KeyDeriver(rootKey)
    const protocolID: [2, string] = [2, 'verifast equivalence']
    for (const forSelf of [false, true]) {
      expect((await keyDeriver.derivePublicKeyAsync(
        protocolID, '3', counterparty, forSelf
      )).toString()).toBe(
        keyDeriver.derivePublicKey(protocolID, '3', counterparty, forSelf).toString()
      )
    }
    expect((await keyDeriver.deriveSymmetricKeyAsync(
      protocolID, '3', counterparty
    )).toHex()).toBe(
      keyDeriver.deriveSymmetricKey(protocolID, '3', counterparty).toHex()
    )

    const acceleratedWallet = new ProtoWallet(rootKey)
    await expect(acceleratedWallet.createSignature(signatureArgs))
      .resolves.toEqual(baselineWalletSignature)
    await expect(acceleratedWallet.createHmac({
      data: [1, 2, 3],
      protocolID: [2, 'verifast equivalence'],
      keyID: '2',
      counterparty: counterparty.toString()
    })).resolves.toEqual(baselineHmac)
    expect((await p2pkhTransaction(rootKey)).toUint8Array())
      .toEqual(baselineTransaction.toUint8Array())
    verifier.dispose()
  })
})
