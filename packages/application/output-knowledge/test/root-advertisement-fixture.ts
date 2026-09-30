import {
  LockingScript,
  canonicalOutputJSON,
  Hash,
  MerklePath,
  outputRootAdvertisementDigest,
  OverlayAdminTokenTemplate,
  P2PKH,
  PrivateKey,
  ProtoWallet,
  signOutputPacket,
  Transaction,
  Utils,
  type OutputRootEvictionRequest,
  type WalletInterface
} from '@bsv/sdk'
import { chain, context, corpus, resolver, transactions } from './evidence-fixture.js'
import type { ChainViewResolver } from '../src/SDKEvidenceVerifier.js'

/** Public synthetic keys and pinned synthetic headers; no production wallet or funds. */
export const advertiserKey = new PrivateKey(81)
export const advertiser = advertiserKey.toPublicKey().toString()
export const evidenceRoot = new PrivateKey(82).toPublicKey().toString()
export const signRootEvidence = (body: OutputRootEvictionRequest, key = advertiserKey) =>
  signOutputPacket('root-eviction-request', body, key)

export async function rootAdvertisementFixture(
  protocol: 'SHIP' | 'SLAP' = 'SHIP',
  outputCount = 1
) {
  const wallet = new ProtoWallet(advertiserKey)
  // This fixture exercises only the template's cryptographic wallet methods.
  // Unexpected action/storage calls fail immediately, rather than acquiring funds.
  const cryptoWallet = new Proxy(wallet, {
    get(target, property) {
      if (!['getPublicKey', 'createSignature'].includes(String(property)))
        throw new Error('Advertisement fixture supports cryptographic operations only')
      const value = Reflect.get(target, property)
      return value.bind(target)
    }
  }) as unknown as WalletInterface
  const template = new OverlayAdminTokenTemplate(cryptoWallet)
  const script = await template.lock(
    protocol,
    'https://advertisement.example',
    protocol === 'SHIP' ? 'tm_example' : 'ls_example'
  )
  const transaction = new Transaction(
    1,
    [
      {
        sourceTransaction: transactions.get('P')!,
        sourceOutputIndex: 0,
        unlockingScriptTemplate: new P2PKH().unlock(new PrivateKey(63)),
        sequence: 0xffffffff
      }
    ],
    Array.from({ length: outputCount }, () => ({ satoshis: 10, lockingScript: script })),
    0
  )
  await transaction.sign()
  const outpoint = { chain, txid: transaction.id('hex'), outputIndex: 0 }
  const service = protocol === 'SHIP' ? 'ls_ship' : 'ls_slap'
  const advertisement = {
    txid: outpoint.txid,
    outputIndex: 0,
    beef: Utils.toBase64(transaction.toAtomicBEEF())
  }
  const body: OutputRootEvictionRequest = {
    version: 1,
    requestId: 'verified_root_request',
    requester: advertiser,
    recipient: evidenceRoot,
    chain,
    issuedAt: '100',
    expiresAt: '200',
    action: 'suppress',
    reason: 'fixture-review',
    targets: [
      {
        service,
        outpoint,
        advertisementDigest: outputRootAdvertisementDigest({
          service,
          outpoint,
          lockingScript: Utils.toBase64(script.toBinary())
        }),
        advertisement,
        evidence: { kind: 'owner-withdrawal', advertisement }
      }
    ]
  }
  const spend = new Transaction(
    1,
    [
      {
        sourceTransaction: transaction,
        sourceOutputIndex: 0,
        unlockingScriptTemplate: template.unlock(protocol),
        sequence: 0xffffffff
      }
    ],
    [{ satoshis: 1, lockingScript: LockingScript.fromHex('51') }],
    0
  )
  await spend.sign()
  return { body, transaction, spend, script }
}

/** Extend the existing easy-work fixture ancestry with two real inclusion paths. */
export function minedRootEvidence(fixture: Awaited<ReturnType<typeof rootAdvertisementFixture>>) {
  const original = context(),
    snapshot = structuredClone(original)
  const extension = new Map<number, { hash: string; merkleRoot: string }>()
  let previous = original.view.tipHash,
    height = Number(original.view.tipHeight)
  const times: number[] = []
  for (let hash: string | undefined = previous; hash;) {
    const header = corpus.headers.find(item => item.hash === hash)!
    const bytes = Uint8Array.from(Utils.toArray(header.raw, 'hex'))
    times.push(new DataView(bytes.buffer).getUint32(68, true))
    hash = header.height === 0 ? undefined : Utils.toHex(Array.from(bytes.slice(4, 36)).reverse())
  }
  let raw = Uint8Array.from(
    Utils.toArray(corpus.headers.find(item => item.hash === previous)!.raw, 'hex')
  )
  for (const transaction of [fixture.transaction, fixture.spend]) {
    const path = new MerklePath(height + 1, [
      [
        {
          offset: 0,
          hash: Utils.toHex(
            Hash.hash256(Utils.toArray(`synthetic-coinbase-leaf-${height + 1}`, 'utf8'))
          )
        },
        { offset: 1, hash: transaction.id('hex'), txid: true }
      ]
    ])
    const merkleRoot = path.computeRoot(transaction.id('hex'))
    raw = raw.slice()
    raw.set(Utils.toArray(previous, 'hex').reverse(), 4)
    raw.set(Utils.toArray(merkleRoot, 'hex').reverse(), 36)
    const view = new DataView(raw.buffer),
      time = view.getUint32(68, true) + 600
    view.setUint32(68, time, true)
    times.unshift(time)
    let nonce = 0
    for (;;) {
      view.setUint32(76, nonce++, true)
      previous = Utils.toHex(Hash.hash256(Array.from(raw)).reverse())
      if (BigInt('0x' + previous) <= 0x7fffffn << 232n) break
    }
    height++
    transaction.merklePath = path
    extension.set(height, { hash: previous, merkleRoot })
  }
  snapshot.id = 'verified-root-mined'
  snapshot.view.id = 'root-evidence-mined'
  snapshot.view.tipHash = previous
  snapshot.view.tipHeight = String(height)
  const median = times.slice(0, 11).sort((a, b) => a - b)
  snapshot.view.medianTimePast = String(median[Math.floor(median.length / 2)])
  const chains: ChainViewResolver = {
    async resolve(view, signal) {
      if (canonicalOutputJSON(view) !== canonicalOutputJSON(snapshot.view))
        throw new Error('Different fixture view')
      const base = await resolver.resolve(original.view, signal)
      return {
        view,
        tracker: {
          currentHeight: async () => height,
          isValidRootForHeight: async (root, height) =>
            extension.has(height)
              ? extension.get(height)!.merkleRoot === root
              : base.tracker.isValidRootForHeight(root, height)
        },
        header: async (height, signal) =>
          extension.get(height) ?? (await base.header(height, signal))
      }
    }
  }
  return { context: snapshot, chains, extension }
}
