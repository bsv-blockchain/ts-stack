import XDMSubstrate from '../../../wallet/substrates/XDM'
import { WalletError } from '../../../wallet/WalletError'
import { Utils } from '../../../primitives/index'
import Transaction from '../../../transaction/Transaction'

const VALID_PUBLIC_KEY = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
const VALID_TXID = 'ab'.repeat(32)
const VALID_DER_SIGNATURE = [0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01]
const VALID_TYPE = Utils.toBase64(Array(32).fill(1))
const VALID_SERIAL = Utils.toBase64(Array(32).fill(2))
const VALID_SIGNATURE_HEX = Utils.toHex(VALID_DER_SIGNATURE)
const MINIMAL_TRANSACTION = new Transaction()
const MINIMAL_BEEF = MINIMAL_TRANSACTION.toAtomicBEEF()
const MINIMAL_TXID = MINIMAL_TRANSACTION.id('hex')

describe('XDMSubstrate', () => {
  let xdmSubstrate: XDMSubstrate
  let originalWindow: (Window & typeof globalThis) | undefined
  let addEventListenerMock: jest.Mock

  beforeEach(() => {
    originalWindow = global.window
    addEventListenerMock = jest.fn()

    global.window = {
      postMessage: jest.fn(),
      parent: {
        postMessage: jest.fn()
      } as unknown as Window,
      addEventListener: addEventListenerMock,
      removeEventListener: jest.fn()
    } as unknown as Window & typeof globalThis

    jest.spyOn(window.parent, 'postMessage')
  })

  afterEach(() => {
    global.window = originalWindow as any
    jest.restoreAllMocks()
  })

  const getMessageListener = () => {
    const calls = addEventListenerMock.mock.calls
    const lastCall = calls[calls.length - 1]
    if (!lastCall) {
      throw new Error('No message listener registered.')
    }
    return lastCall[1] as (event: MessageEvent) => void
  }

  const dispatchMessage = (event: Partial<MessageEvent> & { data: any }) => {
    getMessageListener()({
      source: window.parent,
      origin: 'https://wallet.example',
      ...event
    } as MessageEvent)
  }

  describe('constructor', () => {
    it('should throw if window is not an object', () => {
      ;(global as any).window = undefined
      expect(() => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const _ = new XDMSubstrate()
      }).toThrow('The XDM substrate requires a global window object.')
    })

    it('should throw if window.postMessage is not an object', () => {
      ;(global.window as any).postMessage = undefined
      expect(() => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const _ = new XDMSubstrate()
      }).toThrow('The window object does not seem to support postMessage calls.')
    })

    it('should construct successfully if window and window.postMessage are defined', () => {
      expect(() => {
        xdmSubstrate = new XDMSubstrate()
      }).not.toThrow()
    })

    it.each([0, 1.5, 3_600_001])('rejects unsafe response timeout %p', responseTimeout => {
      expect(() => new XDMSubstrate('*', responseTimeout)).toThrow(
        'XDM responseTimeout must be an integer from 1 to 3600000.'
      )
    })
  })

  describe('invoke', () => {
    beforeEach(() => {
      xdmSubstrate = new XDMSubstrate()
    })

    it('times out and removes its listener when configured for discovery', async () => {
      xdmSubstrate = new XDMSubstrate('*', 5)

      await expect(xdmSubstrate.getVersion({})).rejects.toThrow('XDM wallet response timed out.')
      expect(window.removeEventListener).toHaveBeenCalledWith('message', expect.any(Function))
      expect(Reflect.get(xdmSubstrate, 'pendingInvocations')).toBe(0)
    })

    it('rejects before registering another listener at the pending invocation limit', async () => {
      Reflect.set(xdmSubstrate, 'pendingInvocations', 1024)

      await expect(xdmSubstrate.getVersion({})).rejects.toThrow(
        'XDM wallet pending invocation limit reached.'
      )
      expect(addEventListenerMock).not.toHaveBeenCalled()
      expect(window.parent.postMessage).not.toHaveBeenCalled()
    })

    it('releases its pending slot if listener registration throws', async () => {
      addEventListenerMock.mockImplementationOnce(() => {
        throw new Error('listener registration failed')
      })

      await expect(xdmSubstrate.getVersion({})).rejects.toThrow('listener registration failed')
      expect(Reflect.get(xdmSubstrate, 'pendingInvocations')).toBe(0)
    })

    it('removes its listener when parent postMessage throws', async () => {
      ;(window.parent.postMessage as jest.Mock).mockImplementationOnce(() => {
        throw new Error('postMessage failed')
      })

      await expect(xdmSubstrate.getVersion({})).rejects.toThrow('postMessage failed')
      expect(window.removeEventListener).toHaveBeenCalledWith('message', expect.any(Function))
    })

    it('should send a message to window.parent.postMessage with correct parameters', async () => {
      const call = 'testCall'
      const args = { foo: 'bar' }
      const mockId = 'mockedId'

      jest.spyOn(Utils, 'toBase64').mockReturnValueOnce(mockId)

      xdmSubstrate.invoke(call as any, args) as any
      expect(window.parent.postMessage).toHaveBeenCalledWith(
        {
          type: 'CWI',
          isInvocation: true,
          id: mockId,
          call,
          args
        },
        '*'
      )
    })

    it('should resolve when receiving a valid message', async () => {
      const call = 'testCall'
      const args = { foo: 'bar' }
      const result = { data: 'some data' }
      const mockId = 'mockedId'

      jest.spyOn(Utils, 'toBase64').mockReturnValueOnce(mockId)

      const invokePromise = xdmSubstrate.invoke(call as any, args)

      // Simulate receiving the message
      const event = {
        data: {
          type: 'CWI',
          isInvocation: false,
          id: mockId,
          status: 'success',
          result
        },
        isTrusted: true
      }

      dispatchMessage(event)

      const res = await invokePromise

      expect(res).toEqual(result)
      expect(Reflect.get(xdmSubstrate, 'pendingInvocations')).toBe(0)
    })

    it('should ignore matching messages from a window other than the parent', async () => {
      const mockId = 'mockedId'
      jest.spyOn(Utils, 'toBase64').mockReturnValueOnce(mockId)
      const invokePromise = xdmSubstrate.invoke('testCall' as any, {})

      dispatchMessage({
        data: {
          type: 'CWI',
          isInvocation: false,
          id: mockId,
          status: 'success',
          result: { value: 'spoofed' }
        },
        isTrusted: true,
        source: {} as Window
      })
      dispatchMessage({
        data: {
          type: 'CWI',
          isInvocation: false,
          id: mockId,
          status: 'success',
          result: { value: 'parent' }
        },
        isTrusted: true
      })

      await expect(invokePromise).resolves.toEqual({ value: 'parent' })
    })

    it('should enforce an exact configured origin', async () => {
      const mockId = 'mockedId'
      jest.spyOn(Utils, 'toBase64').mockReturnValueOnce(mockId)
      xdmSubstrate = new XDMSubstrate('https://wallet.example')
      const invokePromise = xdmSubstrate.invoke('testCall' as any, {})
      const response = {
        type: 'CWI',
        isInvocation: false,
        id: mockId,
        status: 'success',
        result: { value: 'accepted' }
      }

      dispatchMessage({
        data: response,
        isTrusted: true,
        origin: 'https://attacker.example'
      })
      dispatchMessage({
        data: response,
        isTrusted: true,
        origin: 'https://wallet.example'
      })

      expect(window.parent.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ id: mockId }),
        'https://wallet.example'
      )
      await expect(invokePromise).resolves.toEqual({ value: 'accepted' })
    })

    it('should preserve wildcard interoperability for opaque parent origins', async () => {
      const mockId = 'mockedId'
      jest.spyOn(Utils, 'toBase64').mockReturnValueOnce(mockId)
      const invokePromise = xdmSubstrate.invoke('testCall' as any, {})

      dispatchMessage({
        data: {
          type: 'CWI',
          isInvocation: false,
          id: mockId,
          status: 'success',
          result: { value: 'opaque-parent' }
        },
        isTrusted: true,
        origin: 'null'
      })

      await expect(invokePromise).resolves.toEqual({ value: 'opaque-parent' })
    })

    it('should ignore malformed message data without throwing', async () => {
      const mockId = 'mockedId'
      jest.spyOn(Utils, 'toBase64').mockReturnValueOnce(mockId)
      const invokePromise = xdmSubstrate.invoke('testCall' as any, {})

      expect(() => {
        dispatchMessage({ data: null, isTrusted: true })
        dispatchMessage({ data: 'not-a-response', isTrusted: true })
      }).not.toThrow()
      dispatchMessage({
        data: {
          type: 'CWI',
          isInvocation: false,
          id: mockId,
          status: 'success',
          result: { value: 'valid' }
        },
        isTrusted: true
      })

      await expect(invokePromise).resolves.toEqual({ value: 'valid' })
    })

    it('should reject when receiving an error message', async () => {
      const call = 'testCall'
      const args = { foo: 'bar' }
      const errorDescription = 'An error occurred'
      const errorCode = 6
      const mockId = 'mockedId'

      jest.spyOn(Utils, 'toBase64').mockReturnValueOnce(mockId)

      const invokePromise = xdmSubstrate.invoke(call as any, args)

      // Simulate receiving the message
      const event = {
        data: {
          type: 'CWI',
          isInvocation: false,
          id: mockId,
          status: 'error',
          description: errorDescription,
          code: errorCode
        },
        isTrusted: true
      }

      dispatchMessage(event)

      await expect(invokePromise).rejects.toThrow(WalletError)
      await expect(invokePromise).rejects.toThrow(errorDescription)
      try {
        await invokePromise
      } catch (err) {
        expect(err.code).toBe(errorCode)
      }
    })

    it.each([1, 42])(
      'redacts details from an unassigned wallet error response code %i',
      async code => {
        const mockId = 'mockedId'
        jest.spyOn(Utils, 'toBase64').mockReturnValueOnce(mockId)
        const invokePromise = xdmSubstrate.getVersion({})

        dispatchMessage({
          data: {
            type: 'CWI',
            isInvocation: false,
            id: mockId,
            status: 'error',
            description: 'database failed at /private/wallet.sqlite',
            code
          },
          isTrusted: true
        })

        await invokePromise.catch(error => {
          expect(error).toBeInstanceOf(WalletError)
          expect(error.code).toBe(1)
          expect(error.message).toBe('Wallet operation failed')
          expect(error.message).not.toContain('/private/wallet.sqlite')
        })
        expect(Reflect.get(xdmSubstrate, 'pendingInvocations')).toBe(0)
      }
    )

    it('rejects a non-affirmative verification result from the parent wallet', async () => {
      const mockId = 'mockedId'
      jest.spyOn(Utils, 'toBase64').mockReturnValueOnce(mockId)
      const invokePromise = xdmSubstrate.verifyHmac({
        data: [],
        hmac: Array(32).fill(0),
        protocolID: [1, 'test protocol'],
        keyID: '1'
      })

      dispatchMessage({
        data: {
          type: 'CWI',
          isInvocation: false,
          id: mockId,
          status: 'success',
          result: { valid: false }
        },
        isTrusted: true
      })

      await expect(invokePromise).rejects.toThrow('valid')
    })

    it('ignores an invalid error envelope rather than constructing a WalletError', async () => {
      const mockId = 'mockedId'
      jest.spyOn(Utils, 'toBase64').mockReturnValueOnce(mockId)
      const invokePromise = xdmSubstrate.getVersion({})

      dispatchMessage({
        data: {
          type: 'CWI',
          isInvocation: false,
          id: mockId,
          status: 'error',
          description: 'invalid code zero',
          code: 0
        },
        isTrusted: true
      })
      dispatchMessage({
        data: {
          type: 'CWI',
          isInvocation: false,
          id: mockId,
          status: 'success',
          result: { version: '1.0.0.0' }
        },
        isTrusted: true
      })

      await expect(invokePromise).resolves.toEqual({ version: '1.0.0.0' })
    })

    it.each([
      ['the type is incorrect', { type: 'WrongType' }, true],
      ['the invocation ID is incorrect', { id: 'wrongId' }, true],
      ['the browser event is untrusted', {}, false]
    ])('should ignore messages when %s', async (_case, messageOverrides, isTrusted) => {
      const call = 'testCall'
      const args = { foo: 'bar' }
      const result = { data: 'some data' }
      const mockId = 'mockedId'

      jest.spyOn(Utils, 'toBase64').mockReturnValueOnce(mockId)

      const invokePromise = xdmSubstrate.invoke(call as any, args)

      const event = {
        data: {
          type: 'CWI',
          isInvocation: false,
          id: mockId,
          status: 'success',
          result,
          ...messageOverrides
        },
        isTrusted
      }

      dispatchMessage(event)

      // The promise should still be pending
      let isResolved = false
      invokePromise.then(() => {
        isResolved = true
      })

      // Wait a bit to ensure no unintended resolution
      await new Promise(resolve => setTimeout(resolve, 1))
      expect(isResolved).toBe(false)
    })

    it('should ignore messages where e.data.isInvocation is true', async () => {
      const call = 'testCall'
      const args = { foo: 'bar' }
      const result = { data: 'some data' }
      const mockId = 'mockedId'

      jest.spyOn(Utils, 'toBase64').mockReturnValueOnce(mockId)

      const invokePromise = xdmSubstrate.invoke(call as any, args)

      // Simulate receiving a message with isInvocation true
      const event = {
        data: {
          type: 'CWI',
          isInvocation: true,
          id: mockId,
          status: 'success',
          result
        },
        isTrusted: true
      }

      dispatchMessage(event)

      // The promise should still be pending
      let isResolved = false
      invokePromise.then(() => {
        isResolved = true
      })

      // Wait a bit to ensure no unintended resolution
      await new Promise(resolve => setTimeout(resolve, 1))
      expect(isResolved).toBe(false)
    })
  })

  // Helper function to test methods
  const testMethod = (methodName: string, args: any, result: any): void => {
    describe(methodName, () => {
      beforeEach(() => {
        xdmSubstrate = new XDMSubstrate()
      })

      it('should call invoke with correct arguments and return the result', async () => {
        const call = methodName
        const mockId = 'mockedId'

        jest.spyOn(Utils, 'toBase64').mockReturnValueOnce(mockId)

        const invokePromise = xdmSubstrate[methodName](args)

        expect(window.parent.postMessage).toHaveBeenCalledWith(
          {
            type: 'CWI',
            isInvocation: true,
            id: mockId,
            call,
            args
          },
          '*'
        )

        const event = {
          data: {
            type: 'CWI',
            isInvocation: false,
            id: mockId,
            status: 'success',
            result
          },
          isTrusted: true
        }

        dispatchMessage(event)

        const res = await invokePromise
        expect(res).toEqual(result)
      })

      it('should throw error when invoke rejects', async () => {
        const call = methodName
        const errorDescription = 'An error occurred'
        const errorCode = 6
        const mockId = 'mockedId'

        jest.spyOn(Utils, 'toBase64').mockReturnValueOnce(mockId)

        const invokePromise = xdmSubstrate[methodName](args)

        expect(window.parent.postMessage).toHaveBeenCalledWith(
          {
            type: 'CWI',
            isInvocation: true,
            id: mockId,
            call,
            args
          },
          '*'
        )

        // Simulate receiving an error message
        const event = {
          data: {
            type: 'CWI',
            isInvocation: false,
            id: mockId,
            status: 'error',
            description: errorDescription,
            code: errorCode
          },
          isTrusted: true
        }

        dispatchMessage(event)

        await expect(invokePromise).rejects.toThrow(WalletError)
        await expect(invokePromise).rejects.toThrow(errorDescription)
        await invokePromise.catch(err => {
          expect(err.code).toBe(errorCode)
        })
      })
    })
  }

  // List of methods to test
  const methodsToTest = [
    {
      methodName: 'createAction',
      args: {
        description: 'Test description',
        inputs: [],
        outputs: []
      },
      result: { txid: MINIMAL_TXID, tx: MINIMAL_BEEF }
    },
    {
      methodName: 'signAction',
      args: {
        spends: {},
        reference: 'cmVm'
      },
      result: { txid: MINIMAL_TXID, tx: MINIMAL_BEEF }
    },
    {
      methodName: 'abortAction',
      args: {
        reference: 'cmVm'
      },
      result: { aborted: true }
    },
    {
      methodName: 'listActions',
      args: {
        labels: []
      },
      result: { totalActions: 0, actions: [] }
    },
    {
      methodName: 'internalizeAction',
      args: {
        tx: MINIMAL_BEEF,
        outputs: [
          {
            outputIndex: 0,
            protocol: 'wallet payment',
            paymentRemittance: {
              derivationPrefix: 'AQ==',
              derivationSuffix: 'Ag==',
              senderIdentityKey: VALID_PUBLIC_KEY
            }
          }
        ],
        description: 'Test description'
      },
      result: { accepted: true }
    },
    {
      methodName: 'listOutputs',
      args: {
        basket: 'someBasket'
      },
      result: { totalOutputs: 0, outputs: [] }
    },
    {
      methodName: 'relinquishOutput',
      args: {
        basket: 'someBasket',
        output: `${VALID_TXID}.0`
      },
      result: { relinquished: true }
    },
    {
      methodName: 'getPublicKey',
      args: {
        identityKey: true
      },
      result: { publicKey: VALID_PUBLIC_KEY }
    },
    {
      methodName: 'revealCounterpartyKeyLinkage',
      args: {
        counterparty: VALID_PUBLIC_KEY,
        verifier: VALID_PUBLIC_KEY
      },
      result: {
        prover: VALID_PUBLIC_KEY,
        verifier: VALID_PUBLIC_KEY,
        counterparty: VALID_PUBLIC_KEY,
        revelationTime: '2026-09-16T00:00:00.000Z',
        encryptedLinkage: [],
        encryptedLinkageProof: []
      }
    },
    {
      methodName: 'revealSpecificKeyLinkage',
      args: {
        counterparty: VALID_PUBLIC_KEY,
        verifier: VALID_PUBLIC_KEY,
        protocolID: [0, 'someProtocol'],
        keyID: 'someKeyID'
      },
      result: {
        prover: VALID_PUBLIC_KEY,
        verifier: VALID_PUBLIC_KEY,
        counterparty: VALID_PUBLIC_KEY,
        protocolID: [0, 'someProtocol'],
        keyID: 'someKeyID',
        encryptedLinkage: [],
        encryptedLinkageProof: [],
        proofType: 1
      }
    },
    {
      methodName: 'encrypt',
      args: {
        plaintext: [],
        protocolID: [0, 'someProtocol'],
        keyID: 'someKeyID'
      },
      result: { ciphertext: [] }
    },
    {
      methodName: 'decrypt',
      args: {
        ciphertext: [],
        protocolID: [0, 'someProtocol'],
        keyID: 'someKeyID'
      },
      result: { plaintext: [] }
    },
    {
      methodName: 'createHmac',
      args: {
        data: [],
        protocolID: [0, 'someProtocol'],
        keyID: 'someKeyID'
      },
      result: { hmac: Array(32).fill(0) }
    },
    {
      methodName: 'verifyHmac',
      args: {
        data: [],
        hmac: Array(32).fill(0),
        protocolID: [0, 'someProtocol'],
        keyID: 'someKeyID'
      },
      result: { valid: true }
    },
    {
      methodName: 'createSignature',
      args: {
        data: [],
        protocolID: [0, 'someProtocol'],
        keyID: 'someKeyID'
      },
      result: { signature: VALID_DER_SIGNATURE }
    },
    {
      methodName: 'verifySignature',
      args: {
        data: [],
        signature: VALID_DER_SIGNATURE,
        protocolID: [0, 'someProtocol'],
        keyID: 'someKeyID'
      },
      result: { valid: true }
    },
    {
      methodName: 'acquireCertificate',
      args: {
        type: VALID_TYPE,
        subject: VALID_PUBLIC_KEY,
        serialNumber: VALID_SERIAL,
        revocationOutpoint: `${VALID_TXID}.0`,
        signature: VALID_SIGNATURE_HEX,
        fields: {},
        certifier: VALID_PUBLIC_KEY,
        keyringRevealer: 'certifier',
        keyringForSubject: {},
        acquisitionProtocol: 'direct'
      },
      result: {
        type: VALID_TYPE,
        subject: VALID_PUBLIC_KEY,
        serialNumber: VALID_SERIAL,
        certifier: VALID_PUBLIC_KEY,
        revocationOutpoint: `${VALID_TXID}.0`,
        signature: VALID_SIGNATURE_HEX,
        fields: {}
      }
    },
    {
      methodName: 'listCertificates',
      args: {
        certifiers: [],
        types: []
      },
      result: {
        totalCertificates: 0,
        certificates: []
      }
    },
    {
      methodName: 'proveCertificate',
      args: {
        certificate: {
          type: VALID_TYPE,
          subject: VALID_PUBLIC_KEY,
          serialNumber: VALID_SERIAL,
          certifier: VALID_PUBLIC_KEY,
          revocationOutpoint: `${VALID_TXID}.0`,
          signature: VALID_SIGNATURE_HEX,
          fields: {}
        },
        fieldsToReveal: [],
        verifier: VALID_PUBLIC_KEY
      },
      result: {
        keyringForVerifier: {}
      }
    },
    {
      methodName: 'relinquishCertificate',
      args: {
        type: VALID_TYPE,
        serialNumber: VALID_SERIAL,
        certifier: VALID_PUBLIC_KEY
      },
      result: { relinquished: true }
    },
    {
      methodName: 'discoverByIdentityKey',
      args: {
        identityKey: VALID_PUBLIC_KEY
      },
      result: {
        totalCertificates: 0,
        certificates: []
      }
    },
    {
      methodName: 'discoverByAttributes',
      args: {
        attributes: { name: 'Alice' }
      },
      result: {
        totalCertificates: 0,
        certificates: []
      }
    },
    {
      methodName: 'isAuthenticated',
      args: {},
      result: { authenticated: true }
    },
    {
      methodName: 'waitForAuthentication',
      args: {},
      result: { authenticated: true }
    },
    {
      methodName: 'getHeight',
      args: {},
      result: { height: 1000 }
    },
    {
      methodName: 'getHeaderForHeight',
      args: { height: 1000 },
      result: { header: '00'.repeat(80) }
    },
    {
      methodName: 'getNetwork',
      args: {},
      result: { network: 'mainnet' }
    },
    {
      methodName: 'getVersion',
      args: {},
      result: { version: '1.0.0.0' }
    }
  ]

  methodsToTest.forEach(({ methodName, args, result }) => {
    testMethod(methodName, args, result)
  })
})
