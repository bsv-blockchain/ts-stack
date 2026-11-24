import { describe, expect, it } from '@jest/globals'
import { LockingScript, Transaction, type LookupAnswer } from '@bsv/sdk'
import { readOutputList } from '../overlay.js'

function answer(tx: Transaction, outputIndex: number): LookupAnswer {
  return { type: 'output-list', outputs: [{ beef: tx.toBEEF(), outputIndex }] }
}

describe('overlay output lists', () => {
  const tx = new Transaction()
  tx.addOutput({ lockingScript: LockingScript.fromASM('OP_TRUE'), satoshis: 7 })
  const outpoint = `${tx.id('hex')}.0`

  it('returns the queried outputs it lists', () => {
    expect(readOutputList(answer(tx, 0), [outpoint]).get(outpoint)).toMatchObject({
      outpoint,
      satoshis: 7
    })
    expect(readOutputList({ type: 'output-list', outputs: [] }, [outpoint]).size).toBe(0)
  })

  it.each([
    [
      'a non-list answer',
      { type: 'freeform', result: {} } as unknown as LookupAnswer,
      'not an output list'
    ],
    [
      'invalid BEEF',
      { type: 'output-list', outputs: [{ beef: [1, 2, 3], outputIndex: 0 }] } as LookupAnswer,
      'invalid BEEF'
    ],
    ['a missing output', answer(tx, 1), 'missing output'],
    ['an unrelated output', answer(tx, 0), 'unrelated output']
  ])('rejects %s', (name, lookup, message) => {
    const queried = name === 'an unrelated output' ? [`${'00'.repeat(32)}.0`] : [outpoint]
    expect(() => readOutputList(lookup, queried)).toThrow(message)
  })

  it('rejects an output answered twice', () => {
    const twice: LookupAnswer = {
      type: 'output-list',
      outputs: [...answer(tx, 0).outputs, ...answer(tx, 0).outputs]
    }
    expect(() => readOutputList(twice, [outpoint])).toThrow('twice')
  })
})
