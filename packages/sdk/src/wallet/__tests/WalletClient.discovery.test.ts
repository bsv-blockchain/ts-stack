import WalletClient from '../WalletClient'
import ReactNativeWebView from '../substrates/ReactNativeWebView'
import XDMSubstrate from '../substrates/XDM'

type Request = { id: string; call: string }
type Transport = 'react-native' | 'xdm'

/** Only the browser/native environment is simulated; SDK discovery and transports are real. */
function walletHost(transport: Transport, respond = true) {
  const listeners = new Set<(event: MessageEvent) => void>()
  const requests: Request[] = []
  const deliver = (request: Request) => {
    requests.push(request)
    if (!respond) return
    setTimeout(
      () => {
        const data = {
          type: 'CWI',
          isInvocation: false,
          id: request.id,
          status: 'success',
          result: request.call === 'getVersion' ? { version: '1.0.0.0' } : { authenticated: true }
        }
        const event = {
          data: transport === 'react-native' ? JSON.stringify(data) : data,
          source: transport === 'react-native' ? null : window.parent,
          origin: 'https://wallet.example',
          isTrusted: true
        } as MessageEvent
        for (const listener of listeners) listener(event)
      },
      request.call === 'getVersion' ? 10 : 10000
    )
  }
  const host = {
    addEventListener: (_name: string, listener: (event: MessageEvent) => void) =>
      listeners.add(listener),
    removeEventListener: (_name: string, listener: (event: MessageEvent) => void) =>
      listeners.delete(listener),
    postMessage: transport === 'xdm' ? deliver : jest.fn(),
    ...(transport === 'react-native'
      ? { ReactNativeWebView: { postMessage: (raw: string) => deliver(JSON.parse(raw)) } }
      : {})
  }
  global.window = host as unknown as Window & typeof globalThis
  Object.defineProperty(window, 'parent', { value: window })
  return { listeners, requests }
}

describe('WalletClient discovery timeout lifecycle', () => {
  const originalWindow = global.window

  beforeEach(() => {
    jest.useFakeTimers()
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No HTTP wallet in this test'))
  })

  afterEach(() => {
    global.window = originalWindow
    jest.restoreAllMocks()
    jest.useRealTimers()
  })

  it.each<Transport>(['react-native', 'xdm'])(
    'does not impose the %s discovery deadline on subsequent user approval',
    async transport => {
      const { listeners, requests } = walletHost(transport)
      const client = new WalletClient()
      const connected = client.connectToSubstrate()
      await jest.advanceTimersByTimeAsync(10)
      await connected
      expect(client.substrate).toBeInstanceOf(
        transport === 'react-native' ? ReactNativeWebView : XDMSubstrate
      )
      expect(listeners.size).toBe(0)
      expect(jest.getTimerCount()).toBe(0)

      const result = client.waitForAuthentication().then(
        value => ({ value }),
        error => ({ error })
      )
      await jest.advanceTimersByTimeAsync(10000)
      expect(await result).toEqual({ value: { authenticated: true } })
      expect(requests.map(request => request.call)).toEqual(['getVersion', 'waitForAuthentication'])
      expect(listeners.size).toBe(0)
      expect(jest.getTimerCount()).toBe(0)
    }
  )

  it.each<Transport>(['react-native', 'xdm'])(
    'still bounds an unresponsive %s discovery and removes its listeners',
    async transport => {
      const { listeners } = walletHost(transport, false)
      const result = new WalletClient().connectToSubstrate().catch(error => error)
      await jest.advanceTimersByTimeAsync(1200)
      expect(await result).toEqual(
        expect.objectContaining({
          message: expect.stringContaining('No wallet available')
        })
      )
      expect(listeners.size).toBe(0)
      expect(jest.getTimerCount()).toBe(0)
    }
  )

  it.each<Transport>(['react-native', 'xdm'])(
    'preserves an explicitly configured %s operation timeout',
    async transport => {
      const { listeners } = walletHost(transport, false)
      const substrate =
        transport === 'react-native' ? new ReactNativeWebView('*', 50) : new XDMSubstrate('*', 50)
      const client = new WalletClient(substrate)
      const result = client.waitForAuthentication().catch(error => error)
      await jest.advanceTimersByTimeAsync(50)
      expect(await result).toEqual(
        expect.objectContaining({
          message: expect.stringContaining('response timed out')
        })
      )
      expect(client.substrate).toBe(substrate)
      expect(listeners.size).toBe(0)
      expect(jest.getTimerCount()).toBe(0)
    }
  )
})
