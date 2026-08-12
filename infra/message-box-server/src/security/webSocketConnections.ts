import type { AuthSocket } from '@bsv/authsocket'

/**
 * Process-local routing state for authenticated Message Box sockets.
 *
 * AuthSocket application events are not raw Socket.IO lifecycle events, so
 * disconnect cleanup must bind through `ioSocket`. Room membership is tracked
 * explicitly because delivery is signed per AuthSocket rather than emitted by
 * Socket.IO's unauthenticated room broadcaster.
 */
export class WebSocketConnectionRegistry {
  private readonly authenticatedIdentities = new Map<string, string>()
  private readonly connectedSockets = new Map<string, AuthSocket>()
  private readonly joinedRooms = new Map<string, Set<string>>()

  register(socket: AuthSocket, onDisconnect?: (reason: unknown) => void): void {
    this.connectedSockets.set(socket.id, socket)
    socket.ioSocket.once('disconnect', reason => {
      this.remove(socket.id)
      onDisconnect?.(reason)
    })
  }

  authenticate(socketId: string, identityKey: string): boolean {
    if (!this.connectedSockets.has(socketId)) return false
    this.authenticatedIdentities.set(socketId, identityKey)
    return true
  }

  isAuthenticated(socketId: string): boolean {
    return this.authenticatedIdentities.has(socketId)
  }

  identityKey(socketId: string): string | undefined {
    return this.authenticatedIdentities.get(socketId)
  }

  join(socketId: string, roomId: string): boolean {
    if (!this.isAuthenticated(socketId)) return false
    const rooms = this.joinedRooms.get(socketId) ?? new Set<string>()
    rooms.add(roomId)
    this.joinedRooms.set(socketId, rooms)
    return true
  }

  leave(socketId: string, roomId: string): void {
    const rooms = this.joinedRooms.get(socketId)
    if (rooms == null) return
    rooms.delete(roomId)
    if (rooms.size === 0) this.joinedRooms.delete(socketId)
  }

  /**
   * Select newest active connections that authenticated as the recipient and
   * joined the exact destination room. Newest-first bounding prevents an old
   * tab population from excluding the currently joining tab.
   */
  recipientSockets(
    recipientIdentity: string,
    roomId: string,
    maxConnections: number
  ): AuthSocket[] {
    const matching = [...this.connectedSockets.entries()]
      .filter(
        ([socketId]) =>
          this.authenticatedIdentities.get(socketId) === recipientIdentity &&
          this.joinedRooms.get(socketId)?.has(roomId) === true
      )
      .map(([, socket]) => socket)

    return maxConnections === -1 ? matching : matching.slice(-maxConnections)
  }

  sockets(): Iterable<AuthSocket> {
    return this.connectedSockets.values()
  }

  clear(): void {
    this.authenticatedIdentities.clear()
    this.connectedSockets.clear()
    this.joinedRooms.clear()
  }

  private remove(socketId: string): void {
    this.authenticatedIdentities.delete(socketId)
    this.connectedSockets.delete(socketId)
    this.joinedRooms.delete(socketId)
  }
}
