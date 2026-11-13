/**
 * Real WebRTC for Node tests, backed by node-datachannel's W3C polyfill.
 *
 * The sandbox drops UDP to non-loopback addresses, so every peer binds to 127.0.0.1.
 */
import type { IceServer, RtcConfig } from 'node-datachannel'
import type { RtcOptions } from '../../src/channel/PeerLink.js'

/**
 * {@link RtcOptions} with the fields `nodeRtc` always sets, so tests can pass it to
 * `PeerLink` or construct a raw peer with `new rtc.RTCPeerConnection(...)`.
 */
export type NodeRtcOptions = RtcOptions &
  Required<Pick<RtcOptions, 'RTCPeerConnection' | 'iceServers' | 'extraConfig'>>

/** RTC options for a node-datachannel peer bound to loopback, with no STUN or TURN. */
export async function nodeRtc(): Promise<NodeRtcOptions> {
  const { RTCPeerConnection } = await import('node-datachannel/polyfill')
  return {
    // The polyfill implements the DOM interface; only its static side differs.
    RTCPeerConnection: RTCPeerConnection as unknown as typeof globalThis.RTCPeerConnection,
    iceServers: [],
    extraConfig: { bindAddress: '127.0.0.1' }
  }
}

/**
 * Release node-datachannel's native threads so jest can exit. Call from `afterAll`
 * once every peer connection in the file is closed; later files can create peers again.
 */
export async function cleanupRtc(): Promise<void> {
  const { cleanup } = await import('node-datachannel')
  cleanup()
}

/** A peer connection made by {@link turnRtc}: node-datachannel's polyfill class. */
export type NodePeerConnection = InstanceType<
  (typeof import('node-datachannel/polyfill'))['RTCPeerConnection']
>

/**
 * {@link nodeRtc} for peers that may relay through TURN, and every peer connection it builds.
 *
 * node-datachannel's polyfill hands each TURN server to libdatachannel as a url,
 * `turn:<username>:<credential>@<host>`, and libdatachannel takes the username to be what
 * comes before the first `:`. A coturn REST username, `<expiry>:<pseudonym>`, thus reaches
 * coturn as `<expiry>` alone and the allocation is refused (coturn logs "credentials of
 * user <expiry> are wrong"). These peer connections give libdatachannel every TURN server
 * as a native `IceServer` object instead (`{ hostname, port, username, password,
 * relayType }`), through the polyfill's `peerConnection` option, which takes a ready native
 * `PeerConnection`; STUN urls pass through as they are. `RtcOptions.extraConfig` cannot
 * carry them: PeerLink drops `iceServers` there (Ruling 22), and a client's TURN servers
 * come per link from its `iceServersProvider`, merged into the configuration this
 * constructor is given.
 */
export async function turnRtc(): Promise<{ rtc: NodeRtcOptions; peers: NodePeerConnection[] }> {
  const { PeerConnection } = await import('node-datachannel')
  const { RTCPeerConnection: Polyfill } = await import('node-datachannel/polyfill')
  const peers: NodePeerConnection[] = []
  let made = 0
  class TurnPeerConnection extends Polyfill {
    constructor(config: RTCConfiguration & { bindAddress?: string } = {}) {
      const native: RtcConfig = { iceServers: (config.iceServers ?? []).flatMap(nativeIceServers) }
      if (config.bindAddress !== undefined) native.bindAddress = config.bindAddress
      if (config.iceTransportPolicy !== undefined) {
        native.iceTransportPolicy = config.iceTransportPolicy
      }
      super({ ...config, peerConnection: new PeerConnection(`turn-peer-${++made}`, native) })
      peers.push(this)
    }
  }
  const rtc = await nodeRtc()
  return {
    rtc: {
      ...rtc,
      RTCPeerConnection: TurnPeerConnection as unknown as typeof globalThis.RTCPeerConnection
    },
    peers
  }
}

/** `server`'s urls for libdatachannel: TURN as native `IceServer` objects, others as is. */
function nativeIceServers(server: RTCIceServer): Array<string | IceServer> {
  const urls = typeof server.urls === 'string' ? [server.urls] : server.urls
  return urls.map(url => {
    const turn = /^(turns?):([^:?]+)(?::(\d+))?(?:\?transport=(udp|tcp))?$/i.exec(url)
    if (turn === null) return url
    const [, scheme, hostname, port, transport] = turn
    const tls = scheme.toLowerCase() === 'turns'
    return {
      hostname,
      port: turnPort(port, tls),
      username: server.username,
      password: server.credential,
      relayType: turnRelayType(tls, transport)
    }
  })
}

/** The url's port, or the TURN default: 5349 for `turns:`, 3478 for `turn:`. */
function turnPort(port: string | undefined, tls: boolean): number {
  if (port !== undefined) return Number(port)
  return tls ? 5349 : 3478
}

/** libdatachannel's relay type: TLS for `turns:`, else TCP or UDP by `?transport=`. */
function turnRelayType(tls: boolean, transport: string | undefined): IceServer['relayType'] {
  if (tls) return 'TurnTls'
  return transport?.toLowerCase() === 'tcp' ? 'TurnTcp' : 'TurnUdp'
}
