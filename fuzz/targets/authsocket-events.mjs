import {
  decodeAuthSocketEventPayload as decodeClient,
  encodeAuthSocketEventPayload as encodeClient
} from '../../packages/messaging/authsocket-client/dist/mod.js'
import {
  decodeAuthSocketEventPayload as decodeServer,
  encodeAuthSocketEventPayload as encodeServer
} from '../../packages/messaging/authsocket/dist/mod.mjs'
import { deepEqual, equalBytes, invariant, utf8 } from '../lib.mjs'

export function fuzz(data) {
  const bytes = Array.from(data.subarray(0, 8192))
  const serverDecoded = decodeServer(bytes)
  const clientDecoded = decodeClient(bytes)
  deepEqual(serverDecoded, clientDecoded, 'AuthSocket server/client decoders diverged')
  invariant(typeof serverDecoded.eventName === 'string', 'AuthSocket decoder lost event name')

  const eventName = utf8(data.subarray(0, 256), 256)
  const value = {
    bytes: data.subarray(256, 768).toString('base64'),
    length: data.length
  }
  const serverEncoded = encodeServer(eventName, value)
  const clientEncoded = encodeClient(eventName, value)
  equalBytes(serverEncoded, clientEncoded, 'AuthSocket server/client encoders diverged')
  deepEqual(
    decodeServer(serverEncoded),
    { eventName, data: value },
    'AuthSocket event payload round trip'
  )
}
