import type { Request as ExpressRequest, Response } from 'express'
import { readMessageBoxResourceConfig } from '../config/resources.js'
import { createLiveDelivery, withLiveDelivery } from './liveDelivery.js'
import type { WebSocketConnectionRegistry } from './webSocketConnections.js'

/**
 * One send reaches up to MAX_RECIPIENTS recipients, each on up to
 * WEBSOCKET_MAX_RECIPIENT_CONNECTIONS sockets. The announce runs off a single
 * request, so the product has to be bounded rather than issued at once.
 */
describe('HTTP live delivery fan-out', () => {
  it('announces to no more recipients at a time than the configured concurrency', async () => {
    const recipients = 40
    let inFlight = 0
    let peak = 0
    const socket = {
      emit: async () => {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        await new Promise(resolve => setTimeout(resolve, 5))
        inFlight -= 1
      }
    }
    const connections = {
      recipientSockets: () => [socket]
    } as unknown as WebSocketConnectionRegistry

    const liveDelivery = createLiveDelivery()
    liveDelivery.connections = connections
    const results = Array.from({ length: recipients }, (_unused, index) => ({
      recipient: `recipient-${index}`,
      messageId: `m-${index}`
    }))

    const req = {
      body: { message: { messageBox: 'fan_out_box', body: 'hi' } },
      auth: { identityKey: 'sender' }
    } as unknown as ExpressRequest
    const res = {
      status: () => res,
      json: () => res
    } as unknown as Response

    await withLiveDelivery(liveDelivery, async (_request, response) => {
      response.status(200)
      response.json({ status: 'success', results })
      return undefined
    })(req, res)

    const limit = readMessageBoxResourceConfig().notificationRecipientConcurrency
    expect(limit).toBeGreaterThan(0)
    expect(limit).toBeLessThan(recipients)
    expect(peak).toBeGreaterThan(1)
    expect(peak).toBeLessThanOrEqual(limit)
  })
})
