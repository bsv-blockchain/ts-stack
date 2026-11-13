import { once } from 'node:events'
import { StorageServer } from '../../remoting/StorageServer'
import { StorageProvider } from '../../StorageProvider'
import { Wallet } from '../../../Wallet'
import { gate, snapshotHttpFixture } from '../../../../test/utils/snapshotArchiveHttpFixtures'

afterEach(() => jest.restoreAllMocks())

function bareServer() {
  return new StorageServer({} as StorageProvider, {
    port: 0,
    wallet: { chain: 'test' } as Wallet,
    monetize: false,
    logRpcRequests: false
  })
}

test('unstarted servers close idempotently and a completed reusable server can start without a configured host', async () => {
  const fixture = await snapshotHttpFixture()
  try {
    const empty = bareServer()
    await empty.close()
    expect(empty.close()).toBe(Reflect.get(empty, 'closing'))
    const listening = jest.spyOn(console, 'log').mockImplementation(() => undefined)
    empty.start()
    await once(empty.server, 'listening')
    expect(listening).toHaveBeenCalledWith('WalletStorageServer listening at http://localhost:0')
    expect(empty.server.listening).toBe(true)
    await empty.close()
    empty.start()
    await once(empty.server, 'listening')
    await empty.close()
    expect(empty.server.listening).toBe(false)
  } finally {
    await fixture.close()
  }
})

test.each(['ERR_SERVER_NOT_RUNNING', 'EIO'])('close waits for the real callback outcome %s', async code => {
  const server = bareServer()
  let complete!: (error?: NodeJS.ErrnoException) => void
  server.server = {
    close: jest.fn((callback: typeof complete) => {
      complete = callback
      return server.server
    })
  }
  let settled = false
  const pending = server.close()
  const observed = pending.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    }
  )
  await new Promise(resolve => setImmediate(resolve))
  expect(settled).toBe(false)
  const error = Object.assign(new Error('fixture listener close failure'), { code })
  complete(error)
  if (code === 'ERR_SERVER_NOT_RUNNING') await expect(pending).resolves.toBeUndefined()
  else {
    await expect(pending).rejects.toBe(error)
    expect(() => server.start()).toThrow('closing')
  }
  await observed
})

test('a capture cleanup rejection remains observable after the HTTP drain finishes', async () => {
  const server = bareServer()
  const http = gate()
  const cleanup = new Error('fixture physical reader cleanup failed')
  let finishHttp!: () => void
  server.server = {
    close: jest.fn((callback: () => void) => {
      finishHttp = callback
      http.resolve()
    })
  }
  Reflect.set(server, 'snapshotArchives', { close: () => Promise.reject(cleanup) })
  let settled = false
  const pending = server.close()
  const observed = pending.catch(() => {
    settled = true
  })
  await http.promise
  await new Promise(resolve => setImmediate(resolve))
  expect(settled).toBe(false)
  finishHttp()
  await expect(pending).rejects.toBe(cleanup)
  await observed
  await expect(server.close()).rejects.toBe(cleanup)
})
