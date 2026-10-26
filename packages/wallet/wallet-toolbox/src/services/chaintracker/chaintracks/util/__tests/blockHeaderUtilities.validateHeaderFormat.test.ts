import { BlockHeader } from '../../../../../sdk/WalletServices.interfaces'
import { validateBaseBlockHeaderFormat, validateHeaderFormat } from '../blockHeaderUtilities'

function makeHeader(): BlockHeader {
  return {
    version: 1,
    previousHash: '00'.repeat(32),
    merkleRoot: '11'.repeat(32),
    time: 1,
    bits: 0x1d00ffff,
    nonce: 1,
    height: 1,
    hash: '22'.repeat(32)
  }
}

describe('validateHeaderFormat integer boundaries', () => {
  it('rejects non-numeric integer fields', () => {
    const header = makeHeader()
    header.version = '1' as unknown as number
    expect(() => validateHeaderFormat(header)).toThrow('Header version must be a number.')
  })

  it('rejects fractional integer fields', () => {
    const header = makeHeader()
    header.version = 1.5
    expect(() => validateHeaderFormat(header)).toThrow('Header version must be an integer.')
  })

  it('rejects integer fields outside their unsigned range', () => {
    const header = makeHeader()
    header.version = -1
    expect(() => validateHeaderFormat(header)).toThrow('Header version must be between 0 and 4294967295.')
  })

  it('continues to structural validation for valid unsigned integers', () => {
    const header = makeHeader()
    header.previousHash = '00'
    expect(() => validateHeaderFormat(header)).toThrow('Header previousHash must be 32 hex bytes.')
  })

  it('rejects non-hex hashes and non-exact records before serialization', () => {
    const invalidHex = makeHeader()
    invalidHex.previousHash = 'zz'.repeat(32)
    expect(() => validateHeaderFormat(invalidHex)).toThrow('previousHash must be 32 hex bytes')

    const extra = { ...makeHeader(), constructor: 'attacker-controlled' }
    expect(() => validateHeaderFormat(extra)).toThrow('exactly the required data properties')
  })

  it('rejects accessor-backed base headers without invoking the accessor', () => {
    const getter = jest.fn(() => 1)
    const header = makeHeader()
    const base = Object.defineProperty(
      {
        previousHash: header.previousHash,
        merkleRoot: header.merkleRoot,
        time: header.time,
        bits: header.bits,
        nonce: header.nonce
      },
      'version',
      { enumerable: true, get: getter }
    )
    expect(() => validateBaseBlockHeaderFormat(base as never)).toThrow('exactly the required data properties')
    expect(getter).not.toHaveBeenCalled()
  })
})
