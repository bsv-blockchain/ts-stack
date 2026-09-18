import { readFileSync } from 'node:fs'
import { expect, test } from '@jest/globals'
import {
  Peer,
  PrivateKey,
  ProtoWallet,
  SimplifiedFetchTransport,
  type WalletInterface
} from '@bsv/sdk'

const http = JSON.parse(
  readFileSync(new URL('../../vectors/auth/brc31-handshake.json', import.meta.url), 'utf8')
)
const socket = JSON.parse(
  readFileSync(new URL('../../vectors/messaging/authsocket.json', import.meta.url), 'utf8')
)
const authrite = JSON.parse(
  readFileSync(
    new URL('../../vectors/messaging/brc31/authrite-signature.json', import.meta.url),
    'utf8'
  )
)

test('the recorded initialRequest matches real Peer and HTTP transport emission', async () => {
  const requests: Array<{ url: string; request: RequestInit }> = []
  const capture: typeof fetch = async (url, request) => {
    requests.push({ url: String(url), request: request ?? {} })
    throw new Error('fixture capture complete')
  }
  const transport = new SimplifiedFetchTransport('https://fixture.invalid', capture)
  const peer = new Peer(new ProtoWallet(new PrivateKey(1)) as WalletInterface, transport)
  await peer.ready
  await expect(peer.getAuthenticatedSession()).rejects.toThrow('fixture capture complete')
  expect(requests).toHaveLength(1)
  const { url, request } = requests[0]
  const fixture = http.vectors[0].input
  expect(new URL(url).pathname).toBe(fixture.path)
  expect(request.method).toBe(fixture.method)
  expect(request.headers).toEqual(fixture.headers)
  const body = JSON.parse(String(request.body))
  // Nonces are random per handshake; only their value is normalized for this comparison.
  expect(Buffer.from(body.initialNonce, 'base64')).toHaveLength(48)
  expect(Buffer.from(fixture.body.initialNonce, 'base64')).toHaveLength(48)
  expect({ ...body, initialNonce: fixture.body.initialNonce }).toEqual(fixture.body)
  expect(socket.vectors[0].input.payload).toEqual(fixture.body)
  expect(Object.keys(body).sort()).toEqual([
    'identityKey',
    'initialNonce',
    'messageType',
    'requestedCertificates',
    'version'
  ])
})

test('BRC metadata separates mutual authentication from Authrite while preserving stable vector IDs', () => {
  expect(http.id).toBe('auth.brc31-handshake')
  expect(http.brc).toEqual(['BRC-103', 'BRC-104'])
  expect(socket.brc).toEqual(['BRC-103'])
  expect(authrite.brc).toContain('BRC-31')
  expect(authrite.brc).not.toContain('BRC-103')
})
