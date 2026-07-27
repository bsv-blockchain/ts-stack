import {
  extractSseFrames,
  parseReorgEvent
} from '../../packages/overlays/overlay-express/dist/esm/src/ReorgStream.js'
import { invariant, utf8 } from '../lib.mjs'

export function fuzz(data) {
  const raw = utf8(data, 65_536)
  const parsed = parseReorgEvent(raw)
  if (parsed !== null) {
    invariant(
      Number.isSafeInteger(parsed.rebuildFromHeight) && parsed.rebuildFromHeight >= 0,
      'Overlay reorg produced an invalid rebuild height'
    )
    invariant(
      Number.isSafeInteger(parsed.newTipHeight) &&
        parsed.newTipHeight >= parsed.rebuildFromHeight - 1,
      'Overlay reorg produced an invalid new tip'
    )
    invariant(
      parsed.orphanedBlockHashes.every(hash => /^[0-9a-f]{64}$/.test(hash)),
      'Overlay reorg retained a malformed orphan hash'
    )
  }
  const frames = extractSseFrames(raw)
  invariant(
    frames.events.every(event => typeof event === 'string') && typeof frames.rest === 'string',
    'Overlay SSE parser returned an invalid shape'
  )

  const numbers = Buffer.alloc(8)
  data.copy(numbers, 0, 0, Math.min(data.length, numbers.length))
  const ancestorHeight = numbers.readUInt32LE(0)
  const tipDelta = numbers.readUInt32LE(4)
  const hash = Buffer.from(data.subarray(8, 40)).toString('hex').padEnd(64, '0')
  const valid = parseReorgEvent(
    JSON.stringify({
      orphanedHashes: [hash.toUpperCase()],
      commonAncestor: { height: ancestorHeight },
      newTip: { height: ancestorHeight + tipDelta }
    })
  )
  invariant(valid !== null, 'Overlay reorg rejected a generated valid event')
  invariant(valid.orphanedBlockHashes[0] === hash, 'Overlay reorg did not canonicalize a hash')
}
