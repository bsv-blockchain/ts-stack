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

  const getMessageListener = (): ((event: { data: string }) => void) => {
    const call = addEventListenerMock.mock.calls.at(-1)
    if (call == null) {
      throw new Error('No message listener registered.')
    }
    return call[1] as (event: { data: string }) => void
  }

  const dispatchMessage = (data: unknown): void => {
    getMessageListener()({ data: JSON.stringify(data) })
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
      await promise.catch((err) => {
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
        () => { settled = true },
        () => { settled = true }
      )

      dispatchMessage({
        type: 'other',
        isInvocation: false,
        id: 'request-id',
        status: 'success',
        result: {}
      })
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

      await new Promise((resolve) => setTimeout(resolve, 1))
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
