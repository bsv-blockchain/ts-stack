import net from 'node:net'
import { BSON } from 'mongodb'

const maxFrameBytes = 4 * 1024 * 1024
const maxBufferedBytes = maxFrameBytes * 2
const opMessage = 2013

function encodeMongoTxnNumber(value: unknown): string {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value.toString(10)
  if (typeof value === 'bigint') return value.toString(10)
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return value
  if (BSON.Long.isLong(value)) return value.toString()
  throw new Error('Mongo commit lacks session identity')
}

export interface CapturedMongoCommit {
  readonly requestId: number
  readonly lsid: string
  readonly txnNumber: string
}

interface Connection {
  client: net.Socket
  upstream: net.Socket
  clientBuffer: Buffer
  upstreamBuffer: Buffer
  commitRequests: Set<number>
}

/**
 * Test-only bounded TCP relay that drops exactly one successful OP_MSG
 * commitTransaction reply after MongoDB has sent it to the relay.
 */
export class MongoCommitResponseProxy {
  public readonly uri: string
  public readonly commits: CapturedMongoCommit[] = []
  public droppedSuccessfulCommitReply = false
  private readonly connections = new Set<Connection>()
  private dropped = false
  private readonly droppedReply: Promise<void>
  private resolveDropped!: () => void

  private constructor(
    private readonly server: net.Server,
    private readonly targetHost: string,
    private readonly targetPort: number,
    port: number
  ) {
    this.uri = `mongodb://127.0.0.1:${port}`
    this.droppedReply = new Promise<void>(resolve => {
      this.resolveDropped = resolve
    })
  }

  public static async create(target: string): Promise<MongoCommitResponseProxy> {
    const url = new URL(`mongodb://${target}`)
    const host = url.hostname
    const port = Number(url.port)
    if (host.length === 0 || !Number.isSafeInteger(port) || port < 1 || port > 65535)
      throw new Error('Invalid Mongo proxy target')
    let proxy: MongoCommitResponseProxy | undefined
    const server = net.createServer(client => proxy?.accept(client))
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })
    const address = server.address()
    if (address === null || typeof address === 'string') {
      await new Promise<void>(resolve => server.close(() => resolve()))
      throw new Error('Mongo proxy did not bind a TCP port')
    }
    proxy = new MongoCommitResponseProxy(server, host, port, address.port)
    return proxy
  }

  public async waitForDroppedReply(timeoutMS = 15000): Promise<void> {
    if (!Number.isSafeInteger(timeoutMS) || timeoutMS < 1 || timeoutMS > 30000)
      throw new Error('Invalid Mongo proxy timeout')
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Mongo proxy did not observe a commit reply')),
        timeoutMS
      )
      timer.unref()
      this.droppedReply.then(
        () => {
          clearTimeout(timer)
          resolve()
        },
        error => {
          clearTimeout(timer)
          reject(error)
        }
      )
    })
  }

  public async close(): Promise<void> {
    for (const connection of this.connections) {
      connection.client.destroy()
      connection.upstream.destroy()
    }
    await new Promise<void>(resolve => this.server.close(() => resolve()))
  }

  private accept(client: net.Socket): void {
    const upstream = net.createConnection({ host: this.targetHost, port: this.targetPort })
    const connection: Connection = {
      client,
      upstream,
      clientBuffer: Buffer.alloc(0),
      upstreamBuffer: Buffer.alloc(0),
      commitRequests: new Set()
    }
    this.connections.add(connection)
    let closed = false
    const close = () => {
      if (closed) return
      closed = true
      this.connections.delete(connection)
      client.destroy()
      upstream.destroy()
    }
    client.once('close', close)
    upstream.once('close', close)
    client.on('error', close)
    upstream.on('error', close)
    client.on('data', data => this.forward(connection, 'client', data))
    upstream.on('data', data => this.forward(connection, 'upstream', data))
  }

  private forward(connection: Connection, direction: 'client' | 'upstream', data: Buffer): void {
    const buffer = Buffer.concat([
      direction === 'client' ? connection.clientBuffer : connection.upstreamBuffer,
      data
    ])
    if (buffer.byteLength > maxBufferedBytes) {
      connection.client.destroy(new Error('Mongo proxy frame buffer exceeded'))
      connection.upstream.destroy()
      return
    }
    let offset = 0
    while (buffer.byteLength - offset >= 16) {
      const length = buffer.readInt32LE(offset)
      if (length < 16 || length > maxFrameBytes) {
        connection.client.destroy(new Error('Mongo proxy received invalid frame length'))
        connection.upstream.destroy()
        return
      }
      if (buffer.byteLength - offset < length) break
      const message = buffer.subarray(offset, offset + length)
      offset += length
      if (direction === 'client') {
        this.observeRequest(connection, message)
        connection.upstream.write(message)
      } else if (this.dropReply(connection, message)) {
        connection.client.destroy()
        connection.upstream.destroy()
        this.resolveDropped()
        return
      } else {
        connection.client.write(message)
      }
    }
    const remainder = buffer.subarray(offset)
    if (direction === 'client') connection.clientBuffer = remainder
    else connection.upstreamBuffer = remainder
  }

  private observeRequest(connection: Connection, message: Buffer): void {
    const header = this.header(message)
    const command = this.command(message)
    if (header === undefined || command?.commitTransaction !== 1) return
    const lsid = command?.lsid
    const txnNumber = command?.txnNumber
    if (lsid === undefined || txnNumber === undefined)
      throw new Error('Mongo commit lacks session identity')
    connection.commitRequests.add(header.requestId)
    this.commits.push({
      requestId: header.requestId,
      lsid: JSON.stringify(lsid),
      txnNumber: encodeMongoTxnNumber(txnNumber)
    })
  }

  private dropReply(connection: Connection, message: Buffer): boolean {
    if (this.dropped) return false
    const header = this.header(message)
    const command = this.command(message)
    if (
      header === undefined ||
      command === undefined ||
      !connection.commitRequests.has(header.responseTo)
    )
      return false
    if (command.ok !== 1) return false
    this.dropped = true
    this.droppedSuccessfulCommitReply = true
    return true
  }

  private header(message: Buffer): { requestId: number; responseTo: number } | undefined {
    if (message.readInt32LE(12) !== opMessage) return undefined
    return { requestId: message.readInt32LE(4), responseTo: message.readInt32LE(8) }
  }

  private command(message: Buffer): Record<string, unknown> | undefined {
    if (message.byteLength < 26 || message[20] !== 0) return undefined
    const length = message.readInt32LE(21)
    if (length < 5 || 21 + length > message.byteLength) return undefined
    try {
      return BSON.deserialize(message.subarray(21, 21 + length)) as Record<string, unknown>
    } catch {
      return undefined
    }
  }
}
