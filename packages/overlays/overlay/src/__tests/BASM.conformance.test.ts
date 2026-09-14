import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { computeBasmRoot, computeTac, BASM_ZERO_HASH } from '../BASM'
import { basmAdmitted } from '../BASMValidation'

interface MerkleVector {
  name: string
  txids: string[]
  root: string
  admissionListValid: boolean
}

interface TacAnchor {
  blockHeight: number
  blockHash: string
  basmRoot: string
  admittedCount: number
  rootSource: string
  expectedTac: string
}

interface TacVector {
  name: string
  genesisHeight: number
  anchors: TacAnchor[]
}

interface ByteOrderVector {
  name: string
  display: string
  internal: string
}

const FIXTURE_PATH = join(__dirname, 'fixtures', 'brc136-independent.json')
const FIXTURE_SHA256 = '51983432bb561e3031fb7c983947dc8bfdcfd0ef828ef9f24093666ff4665c8a'
const fixtureBytes = readFileSync(FIXTURE_PATH)
const fixture = JSON.parse(fixtureBytes.toString('utf8')) as {
  specRevision: { brc136: string; repoHead: string }
  hashEncoding: string
  byteOrder: ByteOrderVector[]
  merkle: MerkleVector[]
  tac: TacVector[]
}
const merkleVectors = fixture.merkle
const tacVectors = fixture.tac

function displayToInternal(hash: string): Buffer {
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    throw new Error(`expected lowercase 32-byte hex, got ${hash}`)
  }
  return Buffer.from(hash, 'hex').reverse()
}

function internalToDisplay(value: Buffer): string {
  if (value.length !== 32) throw new Error('expected 32 bytes')
  return Buffer.from(value).reverse().toString('hex')
}

function sha256d(value: Buffer): Buffer {
  return createHash('sha256').update(createHash('sha256').update(value).digest()).digest()
}

function opensslSha256d(value: Buffer): Buffer {
  const first = execFileSync('openssl', ['dgst', '-sha256', '-binary'], { input: value })
  return execFileSync('openssl', ['dgst', '-sha256', '-binary'], { input: first })
}

function independentBasmRoot(txids: string[], digest: (value: Buffer) => Buffer): string {
  if (txids.length === 0) return BASM_ZERO_HASH
  let layer = txids.map(displayToInternal)
  while (layer.length > 1) {
    const next: Buffer[] = []
    for (let index = 0; index < layer.length; index += 2) {
      const left = layer[index]
      const right = index + 1 < layer.length ? layer[index + 1] : left
      next.push(digest(Buffer.concat([left, right])))
    }
    layer = next
  }
  return internalToDisplay(layer[0])
}

function independentTac(
  previous: string,
  blockHash: string,
  root: string,
  digest: (value: Buffer) => Buffer
): string {
  return internalToDisplay(
    digest(
      Buffer.concat([
        displayToInternal(previous),
        displayToInternal(blockHash),
        displayToInternal(root)
      ])
    )
  )
}

const opensslAvailable = ((): boolean => {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

describe('independent BRC-136 conformance vectors', () => {
  it('pins the BRC revision and frozen fixture bytes', () => {
    expect(fixture.specRevision.brc136).toBe('2733cd2950a739b3c977b95d652ff63e3773c40b')
    expect(fixture.specRevision.repoHead).toBe('39a643ff148a8dcd23ec08986a8ddeb7d5713743')
    expect(fixture.hashEncoding).toBe('lowercase display-order hex')
    expect(createHash('sha256').update(fixtureBytes).digest('hex')).toBe(FIXTURE_SHA256)
    expect(merkleVectors.map(vector => vector.name)).toEqual(
      expect.arrayContaining(['even-four', 'odd-five', 'unsorted-asymmetric-byte-values'])
    )
  })

  it.each(fixture.byteOrder)('reverses display/internal bytes for %s', vector => {
    expect(displayToInternal(vector.display).toString('hex')).toBe(vector.internal)
    expect(internalToDisplay(Buffer.from(vector.internal, 'hex'))).toBe(vector.display)
  })

  it.each(merkleVectors)('independently hashes the ordered admitted list for %s', vector => {
    const independent = independentBasmRoot(vector.txids, sha256d)
    expect(independent).toBe(vector.root)
    expect(computeBasmRoot(vector.txids)).toBe(independent)
    if (vector.txids.length >= 2 && opensslAvailable) {
      expect(independentBasmRoot(vector.txids, opensslSha256d)).toBe(independent)
    }
    const admitted = vector.txids.map((txid, blockIndex) => ({ txid, blockIndex }))
    if (vector.admissionListValid) {
      expect(basmAdmitted(admitted, admitted.length + 1)).toEqual(admitted)
    } else {
      expect(() => basmAdmitted(admitted, admitted.length + 1)).toThrow('unique txids')
    }
  })

  it.each(tacVectors)('independently chains every TAC step for %s', vector => {
    const rootsByName = new Map(merkleVectors.map(root => [root.name, root]))
    let previousTac = BASM_ZERO_HASH
    let expectedHeight = vector.genesisHeight

    for (const anchor of vector.anchors) {
      expect(anchor.blockHeight).toBe(expectedHeight)
      const source = rootsByName.get(anchor.rootSource)
      expect(source).toBeDefined()
      expect(anchor.basmRoot).toBe(source?.root)
      expect(anchor.admittedCount).toBe(source?.txids.length)
      const independent = independentTac(previousTac, anchor.blockHash, anchor.basmRoot, sha256d)
      expect(independent).toBe(anchor.expectedTac)
      expect(computeTac(previousTac, anchor.blockHash, anchor.basmRoot)).toBe(independent)
      if (opensslAvailable) {
        expect(independentTac(previousTac, anchor.blockHash, anchor.basmRoot, opensslSha256d)).toBe(
          independent
        )
      }
      previousTac = independent
      expectedHeight += 1
    }
  })
})
