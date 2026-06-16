import { parseReorgEvent, extractSseFrames } from '../ReorgStream.js'

const HASH_A = 'AABB000000000000000000000000000000000000000000000000000000000000'
const HASH_B = 'ccdd000000000000000000000000000000000000000000000000000000000000'

describe('parseReorgEvent', () => {
  it('maps a go-chaintracks ReorgEvent to handleReorg input (normalizing hashes)', () => {
    const event = JSON.stringify({
      orphanedHashes: [HASH_A, HASH_B],
      commonAncestor: { height: 100, hash: '00ff' },
      newTip: { height: 103, hash: '11ee' },
      depth: 3
    })

    const result = parseReorgEvent(event)

    expect(result).toEqual({
      orphanedBlockHashes: [HASH_A.toLowerCase(), HASH_B],
      rebuildFromHeight: 101,
      newTipHeight: 103
    })
  })

  it('falls back to depth when commonAncestor is absent (reorg past pruned history)', () => {
    const event = JSON.stringify({
      orphanedHashes: [HASH_A],
      commonAncestor: null,
      newTip: { height: 103, hash: '11ee' },
      depth: 3
    })

    const result = parseReorgEvent(event)

    // 103 - 3 + 1 = 101
    expect(result?.rebuildFromHeight).toBe(101)
    expect(result?.newTipHeight).toBe(103)
  })

  it('returns null for malformed frames', () => {
    expect(parseReorgEvent('not json')).toBeNull()
    expect(parseReorgEvent(JSON.stringify({ orphanedHashes: [] }))).toBeNull() // no newTip
  })
})

describe('extractSseFrames', () => {
  it('extracts complete data frames and ignores keepalive comments', () => {
    const buffer = 'data: {"a":1}\n\n: keepalive\n\ndata: {"b":2}\n\n'
    const { events, rest } = extractSseFrames(buffer)
    expect(events).toEqual(['{"a":1}', '{"b":2}'])
    expect(rest).toBe('')
  })

  it('retains a partial trailing frame in rest', () => {
    const buffer = 'data: {"a":1}\n\ndata: {"b":'
    const { events, rest } = extractSseFrames(buffer)
    expect(events).toEqual(['{"a":1}'])
    expect(rest).toBe('data: {"b":')
  })

  it('concatenates multi-line data fields within one frame', () => {
    const buffer = 'data: {"a":\ndata: 1}\n\n'
    const { events, rest } = extractSseFrames(buffer)
    expect(events).toEqual(['{"a":1}'])
    expect(rest).toBe('')
  })
})
