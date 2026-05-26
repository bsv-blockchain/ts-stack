import type { RpcRequest, RpcResponse } from '../types.js';
/**
 * Pure utilities for creating and parsing JSON-RPC messages.
 * No I/O — safe to unit-test in isolation.
 */
export declare class WalletRequestHandler {
    private seq;
    /** Create an RPC request with a unique ID and incrementing seq. */
    createRequest(method: string, params: unknown): RpcRequest;
    /** Create a protocol-level message (pairing_ack, session_revoke, …). */
    createProtocolMessage(method: string, params: unknown): RpcRequest;
    parseMessage(raw: string): RpcRequest | RpcResponse;
    isResponse(msg: RpcRequest | RpcResponse): msg is RpcResponse;
    errorResponse(id: string, seq: number, code: number, message: string): RpcResponse;
}
//# sourceMappingURL=WalletRequestHandler.d.ts.map