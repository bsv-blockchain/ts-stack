import { jest } from '@jest/globals'
import { Peer } from '../Peer.js'
import { SessionManager } from '../SessionManager.js'
import { AuthMessage, PeerSession, RequestedCertificateSet, Transport } from '../types.js'
import { PrivateKey } from '../../primitives/index.js'
import { ListCertificatesResult, ProveCertificateResult } from '../../wallet/Wallet.interfaces.js'
import { CompletedProtoWallet } from '../certificates/__tests/CompletedProtoWallet.js'

// A server may request certificates in its initialResponse and refuse (not queue) a general
// message of that session until a certificateResponse arrives. The default Peer must answer
// that request even when it holds no matching certificate, and must not let a general message
// of the session reach the transport before the answer has been sent or has ended without one.

const certifier = new PrivateKey(9).toPublicKey().toString()
const certificateType = 'z40BOInXkI8m7f/wBrv4MJ09bZfzZbTj2fJqCtONqCY='
const requested: RequestedCertificateSet = {
  certifiers: [certifier],
  types: { [certificateType]: ['firstName'] }
}
const serverKey = new PrivateKey(7)
const serverIdentity = serverKey.toPublicKey().toString()
// Long enough that an unordered general message would overtake the answer.
const WALLET_LATENCY_MS = 50
const payload = [1, 2, 3]

async function settle(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

async function turns(count = 20): Promise<void> {
  for (let i = 0; i < count; i++) await new Promise(resolve => setImmediate(resolve))
}

async function withinMs<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not happen within ${ms}ms`)), ms)
  })
  return await Promise.race([promise, deadline]).finally(() => clearTimeout(timer))
}

class SlowNoCertificateWallet extends CompletedProtoWallet {
  override async listCertificates(): Promise<ListCertificatesResult> {
    await settle(WALLET_LATENCY_MS)
    return { totalCertificates: 0, certificates: [] }
  }
}

class SlowCertificateHolderWallet extends CompletedProtoWallet {
  constructor(private readonly privateKey: PrivateKey) {
    super(privateKey)
  }

  override async listCertificates(): Promise<ListCertificatesResult> {
    await settle(WALLET_LATENCY_MS)
    return {
      totalCertificates: 1,
      certificates: [
        {
          type: certificateType,
          serialNumber: 'c2VyaWFsLW51bWJlci0wMDAwMDAwMDAwMDAwMDAwMDA=',
          subject: this.privateKey.toPublicKey().toString(),
          certifier,
          revocationOutpoint: `${'00'.repeat(32)}.0`,
          fields: { firstName: 'ZW5jcnlwdGVk' },
          signature: '3045022100aa'
        }
      ]
    }
  }

  override async proveCertificate(): Promise<ProveCertificateResult> {
    return { keyringForVerifier: { firstName: 'a2V5' } }
  }
}

class SlowUnavailableWallet extends CompletedProtoWallet {
  override async listCertificates(): Promise<ListCertificatesResult> {
    await settle(WALLET_LATENCY_MS)
    throw new Error('wallet unavailable')
  }
}

class NeverAnsweringWallet extends CompletedProtoWallet {
  override async listCertificates(): Promise<ListCertificatesResult> {
    return await new Promise<never>(() => {})
  }
}

/** One ordered message channel per connection, as a WebSocket is. */
class SocketLikeTransport implements Transport {
  other?: SocketLikeTransport
  readonly sent: AuthMessage[] = []
  readonly handlerErrors: unknown[] = []
  private receive?: (message: AuthMessage) => Promise<void>

  async send(message: AuthMessage): Promise<void> {
    this.sent.push(message)
    const other = this.other as SocketLikeTransport
    setImmediate(() => {
      void other.receive?.(message).catch(error => other.handlerErrors.push(error))
    })
  }

  async onData(callback: (message: AuthMessage) => Promise<void>): Promise<void> {
    this.receive = callback
  }
}

/**
 * The server end of the connection: once its initialResponse has requested certificates, a
 * general message of that session is refused until a certificateResponse of that session
 * arrives. The certificate decision itself belongs to the server's policy; this model admits
 * after any answer.
 */
function gatedConnection(
  clientWallet: CompletedProtoWallet,
  clientSessions?: SessionManager
): {
  client: Peer
  clientTransport: SocketLikeTransport
  arrivals: string[]
  refused: AuthMessage[]
  admitted: AuthMessage[]
} {
  const clientTransport = new SocketLikeTransport()
  const socket = new SocketLikeTransport()
  clientTransport.other = socket
  socket.other = clientTransport
  const arrivals: string[] = []
  const refused: AuthMessage[] = []
  const admitted: AuthMessage[] = []
  const awaitingCertificates = new Set<string>()

  const serverTransport: Transport = {
    async send(message: AuthMessage): Promise<void> {
      if (message.messageType === 'initialResponse' && message.requestedCertificates != null) {
        awaitingCertificates.add(message.initialNonce as string)
      }
      await socket.send(message)
    },
    async onData(callback: (message: AuthMessage) => Promise<void>): Promise<void> {
      await socket.onData(async message => {
        arrivals.push(message.messageType)
        const session = message.yourNonce as string
        if (message.messageType === 'general') {
          ;(awaitingCertificates.has(session) ? refused : admitted).push(message)
          return
        }
        if (message.messageType === 'certificateResponse') awaitingCertificates.delete(session)
        await callback(message)
      })
    }
  }
  void new Peer(new CompletedProtoWallet(serverKey), serverTransport, requested)
  const client = new Peer(clientWallet, clientTransport, undefined, clientSessions)
  return { client, clientTransport, arrivals, refused, admitted }
}

async function untilArrived(arrivals: string[], type: string): Promise<void> {
  await withinMs(
    (async () => {
      while (!arrivals.includes(type)) await settle(5)
    })(),
    3000,
    `arrival of ${type}`
  )
}

describe('Peer answers a certificate request embedded in an initialResponse', () => {
  afterEach(() => {
    jest.useRealTimers()
  })

  test('a peer holding no requested certificate answers with an empty list before its first general message', async () => {
    const connection = gatedConnection(new SlowNoCertificateWallet(new PrivateKey(8)))

    await connection.client.toPeer(payload, serverIdentity)
    await untilArrived(connection.arrivals, 'general')

    expect(connection.arrivals).toEqual(['initialRequest', 'certificateResponse', 'general'])
    expect(connection.refused).toEqual([])
    expect(connection.admitted.map(m => m.payload)).toEqual([payload])
    const answer = connection.clientTransport.sent.find(
      m => m.messageType === 'certificateResponse'
    )
    expect(answer?.certificates).toEqual([])
  }, 15000)

  test('a populated answer also precedes the first general message', async () => {
    const connection = gatedConnection(new SlowCertificateHolderWallet(new PrivateKey(8)))

    await connection.client.toPeer(payload, serverIdentity)
    await untilArrived(connection.arrivals, 'general')

    expect(connection.arrivals).toEqual(['initialRequest', 'certificateResponse', 'general'])
    expect(connection.refused).toEqual([])
    const answer = connection.clientTransport.sent.find(
      m => m.messageType === 'certificateResponse'
    )
    expect(answer?.certificates).toHaveLength(1)
  }, 15000)

  test('a sender that finds the session authenticated while the answer is pending also waits', async () => {
    let client: Peer | undefined
    const concurrent: Array<Promise<void>> = []
    class ObservingSessionManager extends SessionManager {
      // A store whose write completes later, as a persistent one does.
      override async updateSession(session: PeerSession): Promise<void> {
        super.updateSession(session)
        // Fires at the instant the initialResponse makes the session usable, before the answer.
        if (session.isAuthenticated && concurrent.length === 0 && client != null) {
          concurrent.push(client.toPeer([9], serverIdentity))
        }
        await settle(10)
      }
    }
    const connection = gatedConnection(
      new SlowNoCertificateWallet(new PrivateKey(8)),
      new ObservingSessionManager()
    )
    client = connection.client

    await connection.client.toPeer(payload, serverIdentity)
    expect(concurrent).toHaveLength(1)
    await concurrent[0]
    await withinMs(
      (async () => {
        while (connection.arrivals.filter(type => type === 'general').length < 2) await settle(5)
      })(),
      3000,
      'both general messages'
    )

    expect(connection.arrivals).toEqual([
      'initialRequest',
      'certificateResponse',
      'general',
      'general'
    ])
    expect(connection.refused).toEqual([])
  }, 15000)

  test('a wallet failure sends no answer and releases the waiting message for the server to decide', async () => {
    const connection = gatedConnection(new SlowUnavailableWallet(new PrivateKey(8)))

    await withinMs(connection.client.toPeer(payload, serverIdentity), 1000, 'the general send')
    await untilArrived(connection.arrivals, 'general')

    expect(connection.clientTransport.sent.map(m => m.messageType)).toEqual([
      'initialRequest',
      'general'
    ])
    expect(connection.refused).toHaveLength(1)
    await withinMs(
      (async () => {
        while (connection.clientTransport.handlerErrors.length === 0) await settle(5)
      })(),
      3000,
      'the wallet error'
    )
    expect(String(connection.clientTransport.handlerErrors[0])).toContain('wallet unavailable')
  }, 15000)

  test('a wallet that never answers holds the message for at most 30 seconds', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] })
    const connection = gatedConnection(new NeverAnsweringWallet(new PrivateKey(8)))

    let sent = false
    const sending = connection.client.toPeer(payload, serverIdentity).then(() => {
      sent = true
    })
    await turns(60)
    expect(connection.clientTransport.sent.map(m => m.messageType)).toEqual(['initialRequest'])

    await jest.advanceTimersByTimeAsync(29_999)
    await turns()
    expect(sent).toBe(false)
    await jest.advanceTimersByTimeAsync(1)
    await sending
    expect(connection.clientTransport.sent.map(m => m.messageType)).toEqual([
      'initialRequest',
      'general'
    ])
  }, 15000)

  test('an application listener runs outside the hold and may send on the session', async () => {
    const connection = gatedConnection(new SlowNoCertificateWallet(new PrivateKey(8)))
    let listenerSent = false
    connection.client.listenForCertificatesRequested(async verifier => {
      // Awaited inside the callback: a hold that covered listeners would deadlock here.
      await connection.client.toPeer([4], verifier)
      listenerSent = true
    })

    await withinMs(connection.client.toPeer(payload, serverIdentity), 1000, 'the general send')
    await withinMs(
      (async () => {
        while (!listenerSent) await settle(5)
      })(),
      1000,
      "the listener's send"
    )

    // The listener owns its answer; nothing is sent automatically for it.
    expect(
      connection.clientTransport.sent.filter(m => m.messageType === 'certificateResponse')
    ).toEqual([])
  }, 15000)
})
