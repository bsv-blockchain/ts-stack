import ReactNativeWebView from '../ReactNativeWebView'
import { WalletError } from '../../WalletError'
import * as Utils from '../../../primitives/utils'

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
    result: { version: '1.0.0' }
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
      const circular: Record<string, unknown> = {}
      circular.self = circular

      await expect(substrate.invoke('createAction', circular)).rejects.toThrow(TypeError)
      expect(removeEventListenerMock).toHaveBeenCalledWith('message', expect.any(Function))
      expect(postMessageMock).not.toHaveBeenCalled()
    })

    it('times out and removes its listener when configured for discovery', async () => {
      jest.spyOn(Utils, 'toBase64').mockReturnValue('request-id')
      const substrate = new ReactNativeWebView('*', 5)

      await expect(substrate.invoke('getVersion', {})).rejects.toThrow(
        'React Native wallet response timed out.'
      )
      expect(removeEventListenerMock).toHaveBeenCalledWith('message', expect.any(Function))
    })

    it('serializes typed wallet args as portable arrays', () => {
      jest.spyOn(Utils, 'toBase64').mockReturnValue('request-id')
      const substrate = new ReactNativeWebView()

      void substrate.invoke('createAction', {
        description: 'Test action',
        inputBEEF: new Uint8Array([1, 2, 3])
      })

      expect(JSON.parse(postMessageMock.mock.calls[0][0])).toMatchObject({
        args: { inputBEEF: [1, 2, 3] }
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
        result: { version: '1.0.0' }
      })

      await expect(promise).resolves.toEqual({ version: '1.0.0' })
      expect(removeEventListenerMock).toHaveBeenCalledWith('message', expect.any(Function))
    })

    it('repairs numeric-key byte objects in nested wallet responses', async () => {
      jest.spyOn(Utils, 'toBase64').mockReturnValue('request-id')
      const substrate = new ReactNativeWebView()

      const promise = substrate.invoke('createAction', {})
      dispatchMessage({
        type: 'CWI',
        isInvocation: false,
        id: 'request-id',
        status: 'success',
        result: {
          signableTransaction: {
            tx: JSON.parse(JSON.stringify(new Uint8Array([1, 2, 3]))),
            reference: 'cmVm'
          }
        }
      })

      await expect(promise).resolves.toEqual({
        signableTransaction: { tx: [1, 2, 3], reference: 'cmVm' }
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
        result: { version: '1.0.0' }
      }

      dispatchMessage(response, 'https://trusted.example')
      await expect(promise).resolves.toEqual({ version: '1.0.0' })
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
          result: { version: '1.0.0' }
        },
        'https://localhost:3000'
      )

      await expect(promise).resolves.toEqual({ version: '1.0.0' })
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
          result: { version: '1.0.0' }
        },
        ''
      )

      await expect(promise).resolves.toEqual({ version: '1.0.0' })
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
          result: { version: '1.0.0' }
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
      await expect(promise).resolves.toEqual({ version: '1.0.0' })
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
      ;(global.window as any).location = { origin: APP_ORIGIN }
      const substrate = new ReactNativeWebView()
      const promise = substrate.invoke('getVersion', {})

      dispatchMessage(successResponse, APP_ORIGIN, global.window)

      await expect(promise).resolves.toEqual({ version: '1.0.0' })
    })

    it('accepts a response this window dispatches without an origin', async () => {
      jest.spyOn(Utils, 'toBase64').mockReturnValue('request-id')
      ;(global.window as any).location = { origin: APP_ORIGIN }
      const substrate = new ReactNativeWebView()
      const promise = substrate.invoke('getVersion', {})

      dispatchMessage(successResponse, '', global.window)

      await expect(promise).resolves.toEqual({ version: '1.0.0' })
    })

    it('accepts a response this window dispatches with a host-stamped origin', async () => {
      jest.spyOn(Utils, 'toBase64').mockReturnValue('request-id')
      ;(global.window as any).location = { origin: APP_ORIGIN }
      const substrate = new ReactNativeWebView()
      const promise = substrate.invoke('getVersion', {})

      dispatchMessage(successResponse, 'react-native', global.window)

      await expect(promise).resolves.toEqual({ version: '1.0.0' })
    })

    it('accepts a response relayed by a same-origin host frame', async () => {
      jest.spyOn(Utils, 'toBase64').mockReturnValue('request-id')
      ;(global.window as any).location = { origin: APP_ORIGIN }
      ;(global.window as any).parent = HOST_FRAME
      const substrate = new ReactNativeWebView()
      const promise = substrate.invoke('getVersion', {})

      dispatchMessage(successResponse, APP_ORIGIN, HOST_FRAME)

      await expect(promise).resolves.toEqual({ version: '1.0.0' })
    })

    it('accepts a response relayed by a host frame on the configured domain', async () => {
      jest.spyOn(Utils, 'toBase64').mockReturnValue('request-id')
      ;(global.window as any).location = { origin: APP_ORIGIN }
      ;(global.window as any).parent = HOST_FRAME
      const substrate = new ReactNativeWebView('wallet.example')
      const promise = substrate.invoke('getVersion', {})

      dispatchMessage(successResponse, 'https://wallet.example', HOST_FRAME)

      await expect(promise).resolves.toEqual({ version: '1.0.0' })
    })

    it('ignores a response relayed by a cross-origin host frame', async () => {
      jest.spyOn(Utils, 'toBase64').mockReturnValue('request-id')
      ;(global.window as any).location = { origin: APP_ORIGIN }
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
      ;(global.window as any).location = { origin: APP_ORIGIN }
      const substrate = new ReactNativeWebView()
      const promise = substrate.invoke('getVersion', {})

      dispatchMessage(successResponse, 'https://wallet.vendor.example')

      await expect(promise).resolves.toEqual({ version: '1.0.0' })
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
        code: 123
      })

      await expect(promise).rejects.toThrow(WalletError)
      await expect(promise).rejects.toThrow('Action was rejected')
      await promise.catch(err => {
        expect(err.code).toBe(123)
      })
      expect(removeEventListenerMock).toHaveBeenCalledWith('message', expect.any(Function))
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
        result: { version: '1.0.0' }
      })

      await expect(promise).resolves.toEqual({ version: '1.0.0' })
    })
  })
})
