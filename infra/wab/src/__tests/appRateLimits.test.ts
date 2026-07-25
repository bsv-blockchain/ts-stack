import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

jest.mock('../controllers/InfoController', () => ({
  InfoController: { getInfo: (_req: unknown, res: any) => res.sendStatus(204) }
}))
jest.mock('../controllers/AuthController', () => ({
  AuthController: {
    startAuth: (_req: unknown, res: any) => res.sendStatus(204),
    completeAuth: (_req: unknown, res: any) => res.sendStatus(204)
  }
}))
jest.mock('../controllers/UserController', () => ({
  UserController: {
    listLinkedMethods: (_req: unknown, res: any) => res.sendStatus(204),
    unlinkMethod: (_req: unknown, res: any) => res.sendStatus(204),
    deleteUser: (_req: unknown, res: any) => res.sendStatus(204)
  }
}))
jest.mock('../controllers/FaucetController', () => ({
  FaucetController: { requestFaucet: (_req: unknown, res: any) => res.sendStatus(204) }
}))
jest.mock('../controllers/AccountDeletionController', () => ({
  AccountDeletionController: {
    startDeletion: (_req: unknown, res: any) => res.sendStatus(204),
    completeDeletion: (_req: unknown, res: any) => res.sendStatus(204)
  }
}))
jest.mock('../controllers/ShareController', () => ({
  ShareController: {
    storeShare: (_req: unknown, res: any) => res.sendStatus(204),
    retrieveShare: (_req: unknown, res: any) => res.sendStatus(204),
    updateShare: (_req: unknown, res: any) => res.sendStatus(204),
    deleteUser: (_req: unknown, res: any) => res.sendStatus(204)
  }
}))

import app from '../app'

describe('WAB route rate limits', () => {
  let server: Server
  let url: string

  beforeAll(async () => {
    server = app.listen(0, '127.0.0.1')
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve)
      server.once('error', reject)
    })
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close(error => error == null ? resolve() : reject(error))
    })
  })

  it('shares the authentication budget across start and complete routes', async () => {
    for (let attempt = 0; attempt < 9; attempt += 1) {
      expect((await fetch(`${url}/auth/start`, { method: 'POST' })).status).toBe(204)
    }
    expect((await fetch(`${url}/auth/complete`, { method: 'POST' })).status).toBe(204)
    const rejected = await fetch(`${url}/auth/start`, { method: 'POST' })
    expect(rejected.status).toBe(429)
    await expect(rejected.json()).resolves.toMatchObject({ code: 'ERR_RATE_LIMITED' })
  })

  it('shares the user-operation budget across authorization routes', async () => {
    for (let attempt = 0; attempt < 119; attempt += 1) {
      expect((await fetch(`${url}/user/linkedMethods`, { method: 'POST' })).status).toBe(204)
    }
    expect((await fetch(`${url}/user/unlinkMethod`, { method: 'POST' })).status).toBe(204)
    expect((await fetch(`${url}/user/delete`, { method: 'POST' })).status).toBe(429)
  })
})
