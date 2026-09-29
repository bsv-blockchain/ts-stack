import { synchronousPromise } from '../src/internal/synchronousPromise.js'
import { readFileSync } from 'node:fs'
import { Transaction, Hash, Utils, Beef } from '@bsv/sdk'
import type { ChainViewResolver, EvidenceCandidate, VerificationContext } from '../src/index.js'

interface Corpus {
  transactions: Record<string, { txid: string; raw: string; scriptValid: boolean }>
  headers: { height: number; raw: string; hash: string }[]
  views: Record<string, { tipHash: string }>
  anchors: { name: string; beef: string }[]
  inclusion: { name: string; beef: string }
}
export const corpus = JSON.parse(
  readFileSync(new URL('./fixtures/reconciliation-vectors.json', import.meta.url), 'utf8')
) as Corpus
export const chain = { network: 'brc-reconciliation-fixture', genesisHash: corpus.headers[0].hash }
export const partition = { application: 'test-knowledge', account: 'alice', access: 'public' }
export const transactions = new Map(
  Object.entries(corpus.transactions).map(([name, item]) => [name, Transaction.fromHex(item.raw)])
)
const names = new Map(Object.entries(corpus.transactions).map(([name, item]) => [item.txid, name]))
for (const anchor of corpus.anchors)
  transactions.get(anchor.name)!.merklePath = Transaction.fromAtomicBEEF(
    Utils.toArray(anchor.beef, 'base64')
  ).merklePath
for (const tx of transactions.values())
  for (const input of tx.inputs)
    input.sourceTransaction = transactions.get(names.get(input.sourceTXID!) ?? '')
const headers = new Map(
  corpus.headers.map(header => {
    const bytes = Utils.toArray(header.raw, 'hex')
    const data = new DataView(Uint8Array.from(bytes).buffer)
    if (
      Utils.toHex(Hash.hash256(bytes).reverse()) !== header.hash ||
      data.getUint32(72, true) !== 0x207fffff ||
      BigInt('0x' + header.hash) > 0x7fffffn << 232n
    )
      throw new Error('Invalid fixture header')
    return [
      header.hash,
      {
        ...header,
        previous: Utils.toHex(bytes.slice(4, 36).reverse()),
        merkleRoot: Utils.toHex(bytes.slice(36, 68).reverse()),
        time: data.getUint32(68, true)
      }
    ]
  })
)
function ancestry(id: string): NonNullable<ReturnType<typeof headers.get>>[] {
  const result: NonNullable<ReturnType<typeof headers.get>>[] = []
  for (
    let header = headers.get(corpus.views[id].tipHash);
    header;
    header = headers.get(header.previous)
  )
    result.push(header)
  if (result.some((header, index) => header.height !== result.length - index - 1))
    throw new Error('Incomplete fixture ancestry')
  return result
}
export function context(id = 'base'): VerificationContext {
  const branch = ancestry(id),
    times = branch
      .slice(0, 11)
      .map(row => row.time)
      .sort((a, b) => a - b)
  const now = Math.floor(Date.now() / 1000)
  return {
    id: `verification-${id}`,
    partition,
    generation: '0',
    view: {
      id,
      chain,
      tipHash: branch[0].hash,
      tipHeight: String(branch[0].height),
      medianTimePast: String(times[Math.floor(times.length / 2)]),
      chainPolicyDigest: '01'.repeat(32)
    },
    policyDigest: '02'.repeat(32),
    now: String(now),
    limits: { bytes: 4194304, transactions: 4096, dependencies: 16384, deadline: String(now + 30) }
  }
}
export const resolver: ChainViewResolver = {
  resolve(view) {
    return synchronousPromise(() => {
      const branch = ancestry(view.id)
      return {
        view,
        tracker: {
          currentHeight: () => synchronousPromise(() => branch[0].height),
          isValidRootForHeight: (root, height) =>
            synchronousPromise(() =>
              branch.some(row => row.height === height && row.merkleRoot === root)
            )
        },
        header(height) {
          return synchronousPromise(() => {
            const row = branch.find(header => header.height === height)
            if (!row) throw new Error('Historical fixture header unavailable')
            return { hash: row.hash, merkleRoot: row.merkleRoot }
          })
        }
      }
    })
  }
}
export function candidate(
  name: string,
  bytes = transactions.get(name)!.toAtomicBEEF()
): EvidenceCandidate {
  return {
    chain,
    evidence: { txid: corpus.transactions[name].txid, outputIndex: 0, beef: Utils.toBase64(bytes) },
    variantId: Utils.toHex(Hash.sha256(bytes))
  }
}
export function aggregate(...names: string[]): number[] {
  const bundle = new Beef()
  for (const name of names) bundle.mergeBeef(transactions.get(name)!.toBEEF())
  return bundle.toBinary()
}
