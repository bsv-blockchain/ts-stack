import {
  BigNumber,
  ECDSA,
  Hash,
  KeyDeriver,
  PrivateKey,
  ProtoWallet,
  registerAsyncCryptoBackend,
  unregisterAsyncCryptoBackend
} from '@bsv/sdk'
import BdkVerifier from '../src/BdkVerifier.js'

const SAMPLES = 25
const ITERATIONS = 100

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

async function measure(
  operation: () => Promise<void>,
  iterations: number = ITERATIONS
): Promise<number> {
  await operation()
  const samples: number[] = []
  for (let sample = 0; sample < SAMPLES; sample++) {
    const start = performance.now()
    for (let iteration = 0; iteration < iterations; iteration++) {
      await operation()
    }
    samples.push((performance.now() - start) / iterations)
  }
  return median(samples)
}

function printComparison(name: string, javascriptMs: number, wasmMs: number): void {
  console.log(
    `${name.padEnd(30)} ${javascriptMs.toFixed(4).padStart(10)}  ` +
      `${wasmMs.toFixed(4).padStart(10)}  ` +
      `${(javascriptMs / wasmMs).toFixed(2).padStart(7)}x`
  )
}

async function main(): Promise<void> {
  const privateKey = new PrivateKey(42)
  const privateKeyBytes = Uint8Array.from(privateKey.toArray('be', 32))
  const publicKey = privateKey.toPublicKey()
  const publicKeyBytes = Uint8Array.from(publicKey.encode(true) as number[])
  const counterparty = new PrivateKey(99).toPublicKey()
  const digest = Uint8Array.from(Hash.sha256([1, 2, 3, 4]))
  const digestNumber = new BigNumber(Array.from(digest))
  const signature = ECDSA.sign(digestNumber, privateKey, true)
  const signatureBytes = Uint8Array.from(signature.toDER() as number[])
  const protocolID: [2, string] = [2, 'verifast benchmark']
  const signatureArgs = {
    hashToDirectlySign: Array.from(digest),
    protocolID,
    keyID: '1',
    counterparty: counterparty.toString()
  }
  const verifier = new BdkVerifier({
    batchWorkers: 1,
    registerAsDefault: false
  })
  const parallelVerifier = new BdkVerifier({
    batchWorkers: 4,
    batchWorkerThreshold: 32,
    registerAsDefault: false
  })

  try {
    await verifier.preload()
    await parallelVerifier.preloadBatch()

    const wasmSignature = await verifier.signDigest(privateKeyBytes, digest)
    if (!wasmSignature.every((byte, index) => byte === signatureBytes[index])) {
      throw new Error('BDK deterministic signature does not match the SDK')
    }

    console.log(`Node ${process.version}; ${SAMPLES} median samples`)
    console.log('\nGeneric secp256k1 primitives (milliseconds per operation):')
    console.log('operation                           SDK JS    BDK WASM  speedup')
    printComparison(
      'deterministic ECDSA sign',
      await measure(async () => {
        ECDSA.sign(digestNumber, privateKey, true)
      }),
      await measure(async () => {
        await verifier.signDigest(privateKeyBytes, digest)
      })
    )
    printComparison(
      'ECDSA verify',
      await measure(async () => {
        if (!ECDSA.verify(digestNumber, signature, publicKey)) {
          throw new Error('SDK rejected benchmark signature')
        }
      }),
      await measure(async () => {
        if (!(await verifier.verifyDigest(publicKeyBytes, digest, signatureBytes))) {
          throw new Error('BDK rejected benchmark signature')
        }
      })
    )
    printComparison(
      'compressed public key',
      await measure(async () => {
        privateKey.toPublicKey().encode(true)
      }),
      await measure(async () => {
        await verifier.publicKeyFromPrivate(privateKeyBytes)
      })
    )

    const jsDeriver = new KeyDeriver(privateKey)
    const wasmDeriver = new KeyDeriver(privateKey)
    const jsWallet = new ProtoWallet(privateKey)
    const wasmWallet = new ProtoWallet(privateKey)
    const counterpartyWallet = new ProtoWallet(new PrivateKey(99))

    unregisterAsyncCryptoBackend(parallelVerifier)
    const publicDeriveJs = await measure(async () => {
      jsDeriver.derivePublicKey(protocolID, '2', counterparty)
    })
    const symmetricDeriveJs = await measure(async () => {
      jsDeriver.deriveSymmetricKey(protocolID, '2', counterparty)
    }, 25)
    const walletSignJs = await measure(async () => {
      await jsWallet.createSignature(signatureArgs)
    }, 25)
    const walletSignature = await jsWallet.createSignature(signatureArgs)
    const walletVerifyArgs = {
      hashToDirectlyVerify: Array.from(digest),
      signature: walletSignature.signature,
      protocolID,
      keyID: '1',
      counterparty: publicKey.toString()
    }
    const walletVerifyJs = await measure(async () => {
      await counterpartyWallet.verifySignature(walletVerifyArgs)
    }, 25)

    registerAsyncCryptoBackend(parallelVerifier)
    console.log('\nSDK async composition (milliseconds per operation):')
    console.log('operation                           SDK JS    BDK WASM  speedup')
    printComparison(
      'BRC-42 public derivation',
      publicDeriveJs,
      await measure(async () => {
        await wasmDeriver.derivePublicKeyAsync(protocolID, '2', counterparty)
      })
    )
    printComparison(
      'BRC-42 symmetric derivation',
      symmetricDeriveJs,
      await measure(async () => {
        await wasmDeriver.deriveSymmetricKeyAsync(protocolID, '2', counterparty)
      }, 25)
    )
    printComparison(
      'ProtoWallet createSignature',
      walletSignJs,
      await measure(async () => {
        await wasmWallet.createSignature(signatureArgs)
      }, 25)
    )
    printComparison(
      'ProtoWallet verifySignature',
      walletVerifyJs,
      await measure(async () => {
        await counterpartyWallet.verifySignature(walletVerifyArgs)
      }, 25)
    )

    const batchItems = Array.from({ length: 250 }, () => ({
      publicKey: publicKeyBytes,
      digest,
      signature: signatureBytes
    }))
    unregisterAsyncCryptoBackend(parallelVerifier)
    const sdkBatch = await measure(async () => {
      for (const _batchItem of batchItems) {
        if (!ECDSA.verify(digestNumber, signature, publicKey)) {
          throw new Error('SDK rejected benchmark signature')
        }
      }
    }, 1)
    const wasmBatch = await measure(async () => {
      if ((await verifier.verifyDigestBatch(batchItems)).some(valid => !valid)) {
        throw new Error('BDK rejected benchmark batch')
      }
    }, 1)
    const parallelBatch = await measure(async () => {
      if ((await parallelVerifier.verifyDigestBatch(batchItems)).some(valid => !valid)) {
        throw new Error('parallel BDK rejected benchmark batch')
      }
    }, 1)
    console.log('\n250-signature packed batch (milliseconds per complete batch):')
    console.log(`SDK JS: ${sdkBatch.toFixed(3)}`)
    console.log(
      `BDK 1 worker: ${wasmBatch.toFixed(3)} (${(sdkBatch / wasmBatch).toFixed(2)}x vs JS)`
    )
    console.log(
      `BDK 4 workers: ${parallelBatch.toFixed(3)} ` +
        `(${(sdkBatch / parallelBatch).toFixed(2)}x vs JS; ` +
        `${(wasmBatch / parallelBatch).toFixed(2)}x vs one worker)`
    )
  } finally {
    unregisterAsyncCryptoBackend(parallelVerifier)
    verifier.dispose()
    parallelVerifier.dispose()
  }
}

await main()
