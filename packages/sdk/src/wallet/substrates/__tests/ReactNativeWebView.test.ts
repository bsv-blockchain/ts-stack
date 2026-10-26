import ReactNativeWebView from '../ReactNativeWebView'
import { WalletError } from '../../WalletError'
import * as Utils from '../../../primitives/utils'
import Transaction from '../../../transaction/Transaction'

const VALID_ATOMIC_BEEF = new Transaction().toAtomicBEEF()
const VALID_BEEF = new Transaction().toBEEF()

describe('ReactNativeWebView', () => {
  let originalWindow: typeof global.window
  let addEventListenerMock: jest.Mock
  let removeEventListenerMock: jest.Mock
  let postMessageMock: jest.Mock

  beforeEach(() => {
    originalWindow = global.window
    addEventListenerMock = jest.fn()
    removeEventListenerMock = jest.fn()
    postMessageMock = jest.fn()

    global.window = {
      ReactNativeWebView: {
        postMessage: postMessageMock
      },
      addEventListener: addEventListenerMock,
      removeEventListener: removeEventListenerMock
    } as unknown as Window & typeof globalThis
  })

  afterEach(() => {
    global.window = originalWindow
    jest.restoreAllMocks()
  })

  type TestMessageEvent = { data: string; origin?: string; source?: unknown }

  const getMessageListener = (): ((event: TestMessageEvent) => void) => {
    const call = addEventListenerMock.mock.calls.at(-1)
    if (call == null) {
      throw new Error('No message listener registered.')
    }
    return call[1] as (event: TestMessageEvent) => void
  }

  const dispatchMessage = (data: unknown, origin?: string, source?: unknown): void => {
    getMessageListener()({ data: JSON.stringify(data), origin, source })
  }

  const APP_ORIGIN = 'https://app.example'
  const HOSTILE_ORIGIN = 'https://hostile.example'
  const HOST_FRAME = { name: 'host-frame' }

  const successResponse = {
    type: 'CWI',
    isInvocation: false,
    id: 'request-id',
    status: 'success',
    result: { version: '1.0.0.0' }
  }

  describe('constructor', () => {
    it('throws if window is not available', () => {
      ;(global as any).window = undefined

      expect(() => new ReactNativeWebView()).toThrow(
        'The XDM substrate requires a global window object.'
      )
    })

    it('throws if ReactNativeWebView is not bound to window', () => {
      delete (global.window as any).ReactNativeWebView

      expect(() => new ReactNativeWebView()).toThrow(
        'The window object does not have a ReactNativeWebView property.'
      )
    })

    it('throws if ReactNativeWebView does not support postMessage', () => {
      ;(global.window as any).ReactNativeWebView.postMessage = undefined

      expect(() => new ReactNativeWebView()).toThrow(
        'The window.ReactNativeWebView property does not seem to support postMessage calls.'
      )
    })

    it('rejects a non-HTTP domain filter', () => {
      expect(() => new ReactNativeWebView('file:///wallet.html')).toThrow(
        'ReactNativeWebView domain must be an HTTP(S) origin or domain name.'
      )
    })

    it.each([0, 1.5, 3_600_001])('rejects unsafe response timeout %p', responseTimeout => {
      expect(() => new ReactNativeWebView('*', responseTimeout)).toThrow(
        'ReactNativeWebView responseTimeout must be an integer from 1 to 3600000.'
      )
    })

    it('does not trust a spoofed window.hasOwnProperty implementation', () => {
      ;(global.window as any).hasOwnProperty = () => false

      expect(() => new ReactNativeWebView()).not.toThrow()
    })
  })

  describe('invoke', () => {
    it('posts an invocation message to the React Native bridge', () => {
      jest.spyOn(Utils, 'toBase64').mockReturnValue('request-id')
      const substrate = new ReactNativeWebView()

      void substrate.invoke('getVersion', {})

      expect(addEventListenerMock).toHaveBeenCalledWith('message', expect.any(Function))
      expect(postMessageMock).toHaveBeenCalledWith(
        JSON.stringify({
          type: 'CWI',
          isInvocation: true,
          id: 'request-id',
          call: 'getVersion',
          args: {}
        })
      )
    })

    it('removes its listener and rejects when serialization fails', async () => {
      jest.spyOn(Utils, 'toBase64').mockReturnValue('request-id')
      const substrate = new ReactNativeWebView()
      const circular: Record<string, unknown> = { description: 'Test action' }
      circular.self = circular

      await expect(substrate.invoke('createAction', circular)).rejects.toThrow(TypeError)
      expect(removeEventListenerMock).toHaveBeenCalledWith('message', expect.any(Function))
      expect(postMessageMock).not.toHaveBeenCalled()
      expect(Reflect.get(substrate, 'pendingInvocations')).toBe(0)
    })

    it('times out and removes its listener when configured for discovery', async () => {
      jest.spyOn(Utils, 'toBase64').mockReturnValue('request-id')
      const substrate = new ReactNativeWebView('*', 5)

      await expect(substrate.invoke('getVersion', {})).rejects.toThrow(
        'React Native wallet response timed out.'
      )
      expect(removeEventListenerMock).toHaveBeenCalledWith('message', expect.any(Function))
      expect(Reflect.get(substrate, 'pendingInvocations')).toBe(0)
    })

    it('rejects before registering another listener at the pending invocation limit', async () => {
      const substrate = new ReactNativeWebView()
      Reflect.set(substrate, 'pendingInvocations', 1024)

      await expect(substrate.getVersion({})).rejects.toThrow(
        'React Native wallet pending invocation limit reached.'
      )
      expect(addEventListenerMock).not.toHaveBeenCalled()
      expect(postMessageMock).not.toHaveBeenCalled()
    })

    it('releases its pending slot if listener registration throws', async () => {
      const substrate = new ReactNativeWebView()
      addEventListenerMock.mockImplementationOnce(() => {
        throw new Error('listener registration failed')
      })

      await expect(substrate.getVersion({})).rejects.toThrow('listener registration failed')
      expect(Reflect.get(substrate, 'pendingInvocations')).toBe(0)
    })

    it('rejects an oversized serialized request before posting it', async () => {
      jest.spyOn(Utils, 'toBase64').mockReturnValue('request-id')
      jest.spyOn(Utils, 'toUint8Array').mockReturnValueOnce({
        length: 256 * 1024 * 1024 + 1
      } as Uint8Array)
      const substrate = new ReactNativeWebView()

      await expect(substrate.getVersion({})).rejects.toThrow(
        'React Native wallet request exceeds the maximum permitted size.'
      )
      expect(postMessageMock).not.toHaveBeenCalled()
      expect(Reflect.get(substrate, 'pendingInvocations')).toBe(0)
    })

    it('serializes typed wallet args as portable arrays', () => {
      jest.spyOn(Utils, 'toBase64').mockReturnValue('request-id')
      const substrate = new ReactNativeWebView()

      void substrate.invoke('createAction', {
        description: 'Test action',
        inputBEEF: new Uint8Array(VALID_BEEF)
      })

      expect(JSON.parse(postMessageMock.mock.calls[0][0])).toMatchObject({
        args: { inputBEEF: VALID_BEEF }
      })
    })

    it('resolves the result from a matching response', async () => {
      jest.spyOn(Utils, 'toBase64').mockReturnValue('request-id')
      const substrate = new ReactNativeWebView()

      const promise = substrate.invoke('getVersion', {})
      dispatchMessage({
        type: 'CWI',
        isInvocation: false,
        id: 'request-id',
        status: 'success',
        result: { version: '1.0.0.0' }
      })

      await expect(promise).resolves.toEqual({ version: '1.0.0.0' })
      expect(removeEventListenerMock).toHaveBeenCalledWith('message', expect.any(Function))
      expect(Reflect.get(substrate, 'pendingInvocations')).toBe(0)
    })

    it('repairs numeric-key byte objects in nested wallet responses', async () => {
      jest.spyOn(Utils, 'toBase64').mockReturnValue('request-id')
      const substrate = new ReactNativeWebView()

      const promise = substrate.invoke('createAction', {
        description: 'Test action',
        options: { signAndProcess: false }
      })
      dispatchMessage({
        type: 'CWI',
        isInvocation: false,
        id: 'request-id',
        status: 'success',
        result: {
          signableTransaction: {
            tx: JSON.parse(JSON.stringify(new Uint8Array(VALID_ATOMIC_BEEF))),
            reference: 'cmVm'
          }
        }
      })

      await expect(promise).resolves.toEqual({
        signableTransaction: { tx: VALID_ATOMIC_BEEF, reference: 'cmVm' }
      })
    })

    it('normalizes a schemeless configured domain and accepts its full origin', async () => {
      jest.spyOn(Utils, 'toBase64').mockReturnValue('request-id')
      const substrate = new ReactNativeWebView('trusted.example')
      const promise = substrate.invoke('getVersion', {})
      const response = {
        type: 'CWI',
        isInvocation: false,
        id: 'request-id',
        status: 'success',
        result: { version: '1.0.0.0' }
      }

      dispatchMessage(response, 'https://trusted.example')
      await expect(promise).resolves.toEqual({ version: '1.0.0.0' })
    })

    it('normalizes a schemeless configured host with a port', async () => {
      jest.spyOn(Utils, 'toBase64').mockReturnValue('request-id')
      const substrate = new ReactNativeWebView('localhost:3000')
      const promise = substrate.invoke('getVersion', {})

      dispatchMessage(
        {
          type: 'CWI',
          isInvocation: false,
          id: 'request-id',
          status: 'success',
          result: { version: '1.0.0.0' }
        },
        'https://localhost:3000'
      )

      await expect(promise).resolves.toEqual({ version: '1.0.0.0' })
    })

    it('accepts originless native-to-web responses with an explicit domain', async () => {
      jest.spyOn(Utils, 'toBase64').mockReturnValue('request-id')
      const substrate = new ReactNativeWebView('trusted.example')
      const promise = substrate.invoke('getVersion', {})

      dispatchMessage(
        {
          type: 'CWI',
          isInvocation: false,
          id: 'request-id',
          status: 'success',
          result: { version: '1.0.0.0' }
        },
        ''
      )

      await expect(promise).resolves.toEqual({ version: '1.0.0.0' })
    })

    it('rejects a matching response from a mismatched non-empty origin', async () => {
      jest.spyOn(Utils, 'toBase64').mockReturnValue('request-id')
      const substrate = new ReactNativeWebView('trusted.example')
      const promise = substrate.invoke('getVersion', {})

      dispatchMessage(
        {
          type: 'CWI',
          isInvocation: false,
          id: 'request-id',
          status: 'success',
          result: { version: '1.0.0.0' }
        },
        HOSTILE_ORIGIN
      )

      await expect(promise).rejects.toThrow(
        'React Native wallet response origin https://hostile.example did not match https://trusted.example.'
      )
      expect(removeEventListenerMock).toHaveBeenCalledWith('message', expect.any(Function))
    })

    it('ignores a response delivered by another browsing context', async () => {
      jest.spyOn(Utils, 'toBase64').mockReturnValue('request-id')
      const substrate = new ReactNativeWebView()
      const promise = substrate.invoke('getVersion', {})
      let settled = false
      void promise.then(
        () => {
          settled = true
        },
        () => {
          settled = true
        }
      )

      dispatchMessage(successResponse, HOSTILE_ORIGIN, { name: 'hostile-frame' })

      await new Promise(resolve => setTimeout(resolve, 1))
      expect(settled).toBe(false)
      expect(removeEventListenerMock).not.toHaveBeenCalled()

      dispatchMessage(successResponse)
      await expect(promise).resolves.toEqual({ version: '1.0.0.0' })
    })

    it('ignores an opaque-origin response from a sandboxed frame', async () => {
      jest.spyOn(Utils, 'toBase64').mockReturnValue('request-id')
      const substrate = new ReactNativeWebView()
      const promise = substrate.invoke('getVersion', {})
      let settled = false
      void promise.then(
        () => {
          settled = true
        },
        () => {
          settled = true
        }
      )

      dispatchMessage(successResponse, 'null', { name: 'sandboxed-frame' })

      await new Promise(resolve => setTimeout(resolve, 1))
      expect(settled).toBe(false)
      expect(removeEventListenerMock).not.toHaveBeenCalled()
    })

    it('accepts a response posted by this window', async () => {
      jest.spyOn(Utils, 'toBase64').mockReturnValue('request-id')
      ;(global.window as any).origin = APP_ORIGIN
      const substrate = new ReactNativeWebView()
      const promise = substrate.invoke('getVersion', {})

      dispatchMessage(successResponse, APP_ORIGIN, global.window)

      await expect(promise).resolves.toEqual({ version: '1.0.0.0' })
    })

    it('accepts a response this window dispatches without an origin', async () => {
      jest.spyOn(Utils, 'toBase64').mockReturnValue('request-id')
      ;(global.window as any).origin = APP_ORIGIN
      const substrate = new ReactNativeWebView()
      const promise = substrate.invoke('getVersion', {})

      dispatchMessage(successResponse, '', global.window)

      await expect(promise).resolves.toEqual({ version: '1.0.0.0' })
    })

    it('accepts a response this window dispatches with a host-stamped origin', async () => {
      jest.spyOn(Utils, 'toBase64').mockReturnValue('request-id')
      ;(global.window as any).origin = APP_ORIGIN
      const substrate = new ReactNativeWebView()
      const promise = substrate.invoke('getVersion', {})

      dispatchMessage(successResponse, 'react-native', global.window)

      await expect(promise).resolves.toEqual({ version: '1.0.0.0' })
    })

    it('accepts a response relayed by a same-origin host frame', async () => {
      jest.spyOn(Utils, 'toBase64').mockReturnValue('request-id')
      ;(global.window as any).origin = APP_ORIGIN
      ;(global.window as any).parent = HOST_FRAME
      const substrate = new ReactNativeWebView()
      const promise = substrate.invoke('getVersion', {})

      dispatchMessage(successResponse, APP_ORIGIN, HOST_FRAME)

      await expect(promise).resolves.toEqual({ version: '1.0.0.0' })
    })

    it('accepts a response relayed by a host frame on the configured domain', async () => {
      jest.spyOn(Utils, 'toBase64').mockReturnValue('request-id')
      ;(global.window as any).origin = APP_ORIGIN
      ;(global.window as any).parent = HOST_FRAME
      const substrate = new ReactNativeWebView('wallet.example')
      const promise = substrate.invoke('getVersion', {})

      dispatchMessage(successResponse, 'https://wallet.example', HOST_FRAME)

      await expect(promise).resolves.toEqual({ version: '1.0.0.0' })
    })

    it('ignores a response relayed by a cross-origin host frame', async () => {
      jest.spyOn(Utils, 'toBase64').mockReturnValue('request-id')
      ;(global.window as any).origin = APP_ORIGIN
      ;(global.window as any).parent = HOST_FRAME
      const substrate = new ReactNativeWebView()
      const promise = substrate.invoke('getVersion', {})
      let settled = false
      void promise.then(
        () => {
          settled = true
        },
        () => {
          settled = true
        }
      )

      dispatchMessage(successResponse, HOSTILE_ORIGIN, HOST_FRAME)

      await new Promise(resolve => setTimeout(resolve, 1))
      expect(settled).toBe(false)
      expect(removeEventListenerMock).not.toHaveBeenCalled()
    })

    it('accepts a host-synthesized response that stamps the wallet vendor origin', async () => {
      jest.spyOn(Utils, 'toBase64').mockReturnValue('request-id')
      ;(global.window as any).origin = APP_ORIGIN
      const substrate = new ReactNativeWebView()
      const promise = substrate.invoke('getVersion', {})

      dispatchMessage(successResponse, 'https://wallet.vendor.example')

      await expect(promise).resolves.toEqual({ version: '1.0.0.0' })
    })

    it('rejects matching error responses as WalletError', async () => {
      jest.spyOn(Utils, 'toBase64').mockReturnValue('request-id')
      const substrate = new ReactNativeWebView()

      const promise = substrate.invoke('createAction', { description: 'Test action' })
      dispatchMessage({
        type: 'CWI',
        isInvocation: false,
        id: 'request-id',
        status: 'error',
        description: 'Action was rejected',
        code: 6
      })

      await expect(promise).rejects.toThrow(WalletError)
      await expect(promise).rejects.toThrow('Action was rejected')
      await promise.catch(err => {
        expect(err.code).toBe(6)
      })
      expect(removeEventListenerMock).toHaveBeenCalledWith('message', expect.any(Function))
    })

    it.each([1, 42])(
      'redacts details from an unassigned wallet error response code %i',
      async code => {
        jest.spyOn(Utils, 'toBase64').mockReturnValue('request-id')
        const substrate = new ReactNativeWebView()
        const promise = substrate.getVersion({})

        dispatchMessage({
          type: 'CWI',
          isInvocation: false,
          id: 'request-id',
          status: 'error',
          description: 'database failed at /private/wallet.sqlite',
          code
        })

        await promise.catch(error => {
          expect(error).toBeInstanceOf(WalletError)
          expect(error.code).toBe(1)
          expect(error.message).toBe('Wallet operation failed')
          expect(error.message).not.toContain('/private/wallet.sqlite')
        })
        expect(Reflect.get(substrate, 'pendingInvocations')).toBe(0)
      }
    )

    it('rejects a non-affirmative authentication result', async () => {
      jest.spyOn(Utils, 'toBase64').mockReturnValue('request-id')
      const substrate = new ReactNativeWebView()

      const promise = substrate.isAuthenticated({})
      dispatchMessage({
        type: 'CWI',
        isInvocation: false,
        id: 'request-id',
        status: 'success',
        result: { authenticated: false }
      })

      await expect(promise).rejects.toThrow('authenticated')
    })

    it('ignores a malformed success envelope until an exact response arrives', async () => {
      jest.spyOn(Utils, 'toBase64').mockReturnValue('request-id')
      const substrate = new ReactNativeWebView()

      const promise = substrate.getVersion({})
      dispatchMessage({
        type: 'CWI',
        id: 'request-id',
        status: 'success',
        result: { version: 'attacker-version' }
      })
      dispatchMessage({
        type: 'CWI',
        isInvocation: false,
        id: 'request-id',
        status: 'success',
        result: { version: '1.0.0.0' }
      })

      await expect(promise).resolves.toEqual({ version: '1.0.0.0' })
    })

    it('ignores unrelated response messages', async () => {
      jest.spyOn(Utils, 'toBase64').mockReturnValue('request-id')
      const substrate = new ReactNativeWebView()
      const promise = substrate.invoke('getVersion', {})
      let settled = false
      promise.then(
        () => {
          settled = true
        },
        () => {
          settled = true
        }
      )

      dispatchMessage({
        type: 'other',
        isInvocation: false,
        id: 'request-id',
        status: 'success',
        result: {}
      })
      getMessageListener()({ data: '{not-json', origin: HOSTILE_ORIGIN })
      dispatchMessage({
        type: 'CWI',
        isInvocation: false,
        id: 'other-id',
        status: 'success',
        result: {}
      })
      dispatchMessage({
        type: 'CWI',
        isInvocation: true,
        id: 'request-id',
        status: 'success',
        result: {}
      })

      await new Promise(resolve => setTimeout(resolve, 1))
      expect(settled).toBe(false)
      expect(removeEventListenerMock).not.toHaveBeenCalled()

      dispatchMessage({
        type: 'CWI',
        isInvocation: false,
        id: 'request-id',
        status: 'success',
        result: { version: '1.0.0.0' }
      })

      await expect(promise).resolves.toEqual({ version: '1.0.0.0' })
    })
  })
})
