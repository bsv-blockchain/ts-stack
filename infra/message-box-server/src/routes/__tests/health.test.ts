import { beforeEach, describe, expect, jest, test } from '@jest/globals'
import type { Request, Response } from 'express'
import { bindMessageBoxRuntime } from '../../runtimeDeps.js'
import { healthRoute, readinessRoute } from '../health.js'

function createResponse(): jest.Mocked<Response> {
  return {
    setHeader: jest.fn(),
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis()
  } as unknown as jest.Mocked<Response>
}

describe('public health routes', () => {
  let response: jest.Mocked<Response>

  beforeEach(() => {
    response = createResponse()
  })

  test('reports process liveness without exposing dependency details', () => {
    healthRoute.func({} as Request, response)

    expect(response.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store')
    expect(response.status).toHaveBeenCalledWith(200)
    expect(response.json).toHaveBeenCalledWith({ status: 'ok' })
  })

  test('reports readiness when the database responds', async () => {
    const raw = jest.fn<(query: string) => Promise<void>>().mockResolvedValue()
    bindMessageBoxRuntime({ knex: { raw } as never })

    await readinessRoute.func({} as Request, response)

    expect(raw).toHaveBeenCalledWith('select 1')
    expect(response.status).toHaveBeenCalledWith(200)
    expect(response.json).toHaveBeenCalledWith({ status: 'ready' })
  })

  test('returns a stable, non-sensitive readiness failure', async () => {
    const raw = jest.fn<() => Promise<void>>().mockRejectedValue(new Error('secret database host'))
    bindMessageBoxRuntime({ knex: { raw } as never })

    await readinessRoute.func({} as Request, response)

    expect(response.status).toHaveBeenCalledWith(503)
    expect(response.json).toHaveBeenCalledWith({
      status: 'error',
      code: 'ERR_NOT_READY',
      description: 'Message Box dependencies are not ready.'
    })
  })
})
