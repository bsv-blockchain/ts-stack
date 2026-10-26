import { randomUUID } from 'node:crypto'
import type { RpcRequest, RpcResponse } from '../types.js'
import { parseRpcMessage } from '../shared/validation.js'

/**
 * Pure utilities for creating and parsing JSON-RPC messages.
 * No I/O — safe to unit-test in isolation.
 */
export class WalletRequestHandler {
  private seq = 0

  /** Create an RPC request with a unique ID and incrementing seq. */
  createRequest(method: string, params: unknown): RpcRequest {
    return { id: randomUUID(), seq: ++this.seq, method, params }
  }

  /** Create a protocol-level message (pairing_ack, session_revoke, …). */
  createProtocolMessage(method: string, params: unknown): RpcRequest {
    return { id: randomUUID(), seq: ++this.seq, method, params }
  }

  parseMessage(raw: string): RpcRequest | RpcResponse {
    return parseRpcMessage(JSON.parse(raw))
  }

  isResponse(msg: RpcRequest | RpcResponse): msg is RpcResponse {
    return 'result' in msg || 'error' in msg
  }

  errorResponse(id: string, seq: number, code: number, message: string): RpcResponse {
    return { id, seq, error: { code, message } }
  }
}
