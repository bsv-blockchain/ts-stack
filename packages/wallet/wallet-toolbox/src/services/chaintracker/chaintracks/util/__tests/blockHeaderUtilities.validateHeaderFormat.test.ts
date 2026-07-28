import { BlockHeader } from '../../../../../sdk/WalletServices.interfaces'
import { validateHeaderFormat } from '../blockHeaderUtilities'

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
})
