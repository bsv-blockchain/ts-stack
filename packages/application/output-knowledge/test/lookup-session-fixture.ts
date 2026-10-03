import { PrivateKey, retainOutputCapability, signOutputPacket } from '@bsv/sdk'
import { LookupSessionCodec, type LookupSessionOpening } from '../src/lookup/LookupSessionCodec.js'
import { LookupCursorCodec } from '../src/lookup/LookupCursorCodec.js'
import { lookupServingEpochExtension } from '../src/lookup/LookupServingEpoch.js'
import { liveFixture } from './live-lookup-fixture.js'

export function lookupSessionFixture(
  authentication: 'none' | 'brc103' = 'none',
  epoch = '03'.repeat(32),
  watermark = '5'
) {
  const source = liveFixture({}, 'https://lookup.example.test/api', authentication)
  const session = '01'.repeat(32),
    secret = '02'.repeat(32)
  const manifest = signOutputPacket(
    'capabilities',
    {
      ...source.options.manifest.body,
      extensions: lookupServingEpochExtension([{ service: source.open.service, epoch }])
    },
    new PrivateKey(1)
  )
  const cursor = new LookupCursorCodec(secret, session, epoch)
  const value: LookupSessionOpening = {
    principal: authentication === 'none' ? null : new PrivateKey(2).toPublicKey().toString(),
    open: source.open,
    contract: retainOutputCapability(manifest, source.selection).record,
    time: '1000',
    watermark,
    session,
    secret,
    access: source.packet.scope.access,
    epoch,
    first: {
      ...source.packet,
      through: watermark,
      highWater: watermark,
      scope: { ...source.packet.scope, epoch },
      limits: { ...source.packet.limits },
      session,
      cursor: cursor.seal({ phase: 'live', through: watermark })
    },
    guards: [{ id: 'serving', revision: '0', failure: 'reset-required' }]
  }
  const codec = new LookupSessionCodec(source.selection)
  return { source, value, cursor, codec }
}
