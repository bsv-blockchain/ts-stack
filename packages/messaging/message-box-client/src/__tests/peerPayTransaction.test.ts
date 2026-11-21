import fc from 'fast-check'
import { decodePeerPayTransaction } from '../Utils/peerPayTransaction.js'

describe('BRC-29 canonical base64 receive boundary', () => {
  it.each([
    ['AQ==', [1]],
    ['AQI=', [1, 2]],
    ['AQID', [1, 2, 3]],
    ['+/8=', [251, 255]],
    ['AAAA', [0, 0, 0]]
  ])('decodes shared wire vector %s', (wire, expected) => {
    expect(decodePeerPayTransaction(wire as string, 3)).toEqual(expected)
  })

  it.each([
    '',
    'A',
    'AQ',
    'AQ=',
    'AQ===',
    '=AAA',
    'A=AA',
    'AA=A',
    '====',
    'AR==',
    'AQJ=',
    'AQ==\n',
    ' AQ==',
    'AQ I',
    '-_8=',
    'ＡQ=='
  ])('rejects %j', wire => {
    expect(() => decodePeerPayTransaction(wire, 3)).toThrow('canonical base64')
  })

  it('checks decoded length as well as encoded length, before allocation', () => {
    expect(() => decodePeerPayTransaction('AQID', 2)).toThrow('canonical base64')
    expect(() => decodePeerPayTransaction('AQIDAQ==', 3)).toThrow('canonical base64')
    expect(decodePeerPayTransaction('AQI=', 2)).toEqual([1, 2])
  })

  it('matches an independent RFC 4648 encoder over all byte values and lengths', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 1, maxLength: 4096 }), bytes => {
        expect(
          decodePeerPayTransaction(Buffer.from(bytes).toString('base64'), bytes.length)
        ).toEqual(Array.from(bytes))
      }),
      { numRuns: 200 }
    )
  })
})
