import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BigNumber, CachedKeyDeriver, Curve, PrivateKey, Utils } from '@bsv/sdk'
import {
  parsePoint33,
  SigmaPermissionModule,
  verifyDleq,
  verifyOr,
  verifySchnorr
} from '../index.js'
import { call } from './helpers.js'

interface Vector {
  name: string
  wallet: 'A' | 'B'
  securityLevel: 0 | 1 | 2
  logicalProtocolID: string
  keyID: string
  counterparty: string
  operation: 'key' | 'schnorr' | 'dleq' | 'or'
  plaintextHex: string
  childKeyHex: string
  scalarHex: string
  statementPointHex: string
  resultHex: string
}
interface Fixture {
  parameters: { contextHex: string; points: Record<string, string> }
  wallets: Record<'A' | 'B', { rootPrivateKeyHex: string; identityKeyHex: string }>
  vectors: Vector[]
}

const FIXTURE_PATH = join(__dirname, 'fixtures', 'sigma-vectors.json')
const EXPECTED_NAMES = [
  'key-self',
  'key-counterparty-b',
  'key-counterparty-a',
  'key-anyone',
  'key-with-base',
  'schnorr',
  'dleq',
  'or-n2-position-1',
  'or-n2-position-2',
  'or-n3-position-2'
]
const curve = new Curve()
const bytes = (hex: string): number[] => Utils.toArray(hex, 'hex')
const hex = (data: number[]): string => Utils.toHex(data)

describe('sigma conformance vectors', () => {
  it('has the fixture with exactly the ten vectors', () => {
    expect(existsSync(FIXTURE_PATH)).toBe(true)
    const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as Fixture
    expect(fixture.vectors.map(v => v.name)).toEqual(EXPECTED_NAMES)
  })

  const fixture = existsSync(FIXTURE_PATH)
    ? (JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as Fixture)
    : { vectors: [], wallets: {}, parameters: {} }

  it.each((fixture as Fixture).vectors.map(v => [v.name, v] as const))('%s', async (_name, v) => {
    const { wallets } = fixture as Fixture
    const root = new PrivateKey(wallets[v.wallet].rootPrivateKeyHex, 16)
    const module = new SigmaPermissionModule({
      keyDeriver: new CachedKeyDeriver(root),
      authorize: async () => true
    })
    const plaintext = bytes(v.plaintextHex)
    const { ciphertext } = await call(
      module,
      v.operation,
      plaintext,
      {
        protocolID: [v.securityLevel, `p sigma ${v.operation} ${v.logicalProtocolID}`],
        keyID: v.keyID,
        counterparty: v.counterparty
      },
      { originator: 'vectors.example' }
    )
    expect(hex(ciphertext)).toBe(v.resultHex)

    // The independently derived scalar must be the key behind the statement point.
    const P = curve.g.mul(new BigNumber(v.scalarHex, 16))
    expect(hex(P.encode(true) as number[])).toBe(v.statementPointHex)
    const statement = parsePoint33(bytes(v.statementPointHex), 'P')

    switch (v.operation) {
      case 'key': {
        const base = plaintext.length === 0 ? curve.g : parsePoint33(plaintext, 'H')
        expect(hex(base.mul(new BigNumber(v.scalarHex, 16)).encode(true) as number[])).toBe(
          v.resultHex
        )
        break
      }
      case 'schnorr':
        expect(verifySchnorr(statement, plaintext, ciphertext)).toBe(true)
        break
      case 'dleq':
        expect(
          verifyDleq(
            statement,
            parsePoint33(plaintext.slice(0, 33), 'H'),
            plaintext.slice(33),
            ciphertext
          )
        ).toBe(true)
        break
      case 'or': {
        const n = plaintext[0]
        const position = plaintext[1]
        const ring = []
        for (let j = 0; j < n - 1; j++) {
          ring.push(parsePoint33(plaintext.slice(2 + 33 * j, 2 + 33 * (j + 1)), 'ring point'))
        }
        ring.splice(position - 1, 0, statement)
        expect(verifyOr(ring, plaintext.slice(2 + 33 * (n - 1)), ciphertext)).toBe(true)
        break
      }
    }
  })
})
