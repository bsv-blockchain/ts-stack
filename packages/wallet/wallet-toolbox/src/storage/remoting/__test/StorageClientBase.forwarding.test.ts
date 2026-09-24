import type { WalletInterface } from '@bsv/sdk'
import { StorageClientBase } from '../StorageClientBase'

class ForwardingClient extends StorageClientBase {
  constructor(private readonly send: (method: string, params: unknown[]) => Promise<unknown>) {
    super({} as WalletInterface, 'https://storage.example.test')
  }

  protected rpcCall<T>(method: string, params: unknown[]): Promise<T> {
    return this.send(method, params) as Promise<T>
  }
}

const auth = { identityKey: `02${'11'.repeat(32)}`, userId: 7, isActive: true }
const abort = { reference: 'action-reference' }
const cases = [
  { method: 'getCapabilities', params: [], run: (client: ForwardingClient) => client.getCapabilities() },
  { method: 'abortAction', params: [auth, abort], run: (client: ForwardingClient) => client.abortAction(auth, abort) },
  {
    method: 'renewActionBatch',
    params: [auth, 'batch-reference'],
    run: (client: ForwardingClient) => client.renewActionBatch(auth, 'batch-reference')
  }
]

test.each(cases)('$method converts custom synchronous transport errors to rejected promises', async ({ run }) => {
  const failure = new Error('synchronous custom transport failure')
  const client = new ForwardingClient(() => {
    throw failure
  })
  const operation = run(client)
  expect(operation).toBeInstanceOf(Promise)
  await expect(operation).rejects.toBe(failure)
})

test.each(cases)('$method preserves asynchronous transport failure identity', async ({ run }) => {
  const failure = new Error('asynchronous custom transport failure')
  const client = new ForwardingClient(async () => {
    throw failure
  })
  await expect(run(client)).rejects.toBe(failure)
})

test.each(cases)(
  '$method waits for transport settlement and retains parameters and result',
  async ({ method, params, run }) => {
    let finish!: (value: unknown) => void
    const pending = new Promise<unknown>(resolve => {
      finish = resolve
    })
    const send = jest.fn(() => pending)
    const client = new ForwardingClient(send)
    const settled = jest.fn()
    const operation = run(client).then(value => {
      settled()
      return value
    })
    await Promise.resolve()
    expect(settled).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith(method, params)
    const result = { received: true }
    finish(result)
    await expect(operation).resolves.toBe(result)
    expect(settled).toHaveBeenCalledTimes(1)
  }
)
