import { WABClient } from '../WABClient'

describe('WABClient endpoint mapping', () => {
  it('maps every user and share operation to the bounded transport', async () => {
    const client = new WABClient('https://wab.example')
    const request = jest.spyOn(client.transport, 'request').mockImplementation(async path => {
      if (path === '/user/linkedMethods') return { authMethods: [] } as never
      if (path === '/faucet/request') {
        return {
          success: true,
          paymentData: { k: '1', tx: [1], txid: 'b'.repeat(64) }
        } as never
      }
      if (path === '/share/retrieve') {
        return { success: true, shareB: '1.2.2.deadbeef' } as never
      }
      if (path === '/share/update') return { success: true, shareVersion: 2 } as never
      return { success: true } as never
    })
    const key = 'a'.repeat(64)
    const phonePayload = { phoneNumber: ' +12065550100 ' }

    await client.listLinkedMethods(key)
    await client.unlinkMethod(key, 7)
    await client.requestFaucet(key)
    await client.finalizeRegistration(key)
    await client.deleteUser(key)
    await client.startShareAuth('TwilioPhone', key, phonePayload)
    await client.storeShare('TwilioPhone', phonePayload, '1.2.2.deadbeef', key)
    await client.retrieveShare('TwilioPhone', phonePayload, key)
    await client.updateShare('TwilioPhone', phonePayload, key, '2.3.2.deadbeef')
    await client.deleteShamirUser('TwilioPhone', phonePayload, key)

    expect(request.mock.calls.map(([path]) => path)).toEqual([
      '/user/linkedMethods',
      '/user/unlinkMethod',
      '/faucet/request',
      '/auth/registration/finalize',
      '/user/delete',
      '/auth/start',
      '/share/store',
      '/share/retrieve',
      '/share/update',
      '/share/delete'
    ])
    expect(request).toHaveBeenCalledWith('/share/store', {
      operation: 'store-share',
      body: {
        methodType: 'TwilioPhone',
        payload: { phoneNumber: '+12065550100' },
        shareB: '1.2.2.deadbeef',
        userIdHash: key
      }
    })
  })

  it('rejects malformed identifiers, method IDs, method names, and phone identities before transport', async () => {
    const client = new WABClient('https://wab.example')
    const request = jest.spyOn(client.transport, 'request').mockResolvedValue({ success: true } as never)
    await expect(client.listLinkedMethods('bad')).rejects.toThrow('32-byte')
    await expect(client.unlinkMethod('a'.repeat(64), 0)).rejects.toThrow('positive safe integer')
    await expect(client.startShareAuth('../bad', 'a'.repeat(64), {})).rejects.toThrow('unsupported characters')
    await expect(client.startShareAuth('TwilioPhone', 'a'.repeat(64), {})).rejects.toThrow('requires phoneNumber')
    await expect(client.startShareAuth('TwilioPhone', 'a'.repeat(64), { phoneNumber: '555-0100' })).rejects.toThrow(
      'canonical E.164'
    )
    expect(request).not.toHaveBeenCalled()
    expect(client.generateRandomPresentationKey()).toMatch(/^[0-9a-f]{64}$/)
  })

  it('rejects truthy non-boolean verdicts and malformed wallet-authority response fields', async () => {
    const client = new WABClient('https://wab.example')
    const request = jest.spyOn(client.transport, 'request')
    const key = 'a'.repeat(64)

    request.mockResolvedValueOnce({ success: 'false' } as never)
    await expect(client.deleteUser(key)).rejects.toMatchObject({ code: 'WAB_INVALID_RESPONSE' })

    request.mockResolvedValueOnce({ success: true, shareB: 'not-a-share' } as never)
    await expect(client.retrieveShare('DevConsole', {}, key)).rejects.toMatchObject({ code: 'WAB_INVALID_RESPONSE' })

    request.mockResolvedValueOnce({ success: true, paymentData: { k: '1', tx: [256], txid: key } } as never)
    await expect(client.requestFaucet(key)).rejects.toMatchObject({ code: 'WAB_INVALID_RESPONSE' })

    request.mockResolvedValueOnce({ success: true, message: 'accepted\nforged-log-line' } as never)
    await expect(client.unlinkMethod(key, 1)).rejects.toMatchObject({ code: 'WAB_INVALID_RESPONSE' })
  })

  it('validates auth interactor responses before exposing their typed verdicts', async () => {
    const client = new WABClient('https://wab.example')
    const key = 'a'.repeat(64)
    const authMethod = {
      methodType: 'Hostile',
      startAuth: jest.fn(async () => ({ success: 'false' })),
      completeAuth: jest.fn(async () => ({ success: true, presentationKey: 'bad' }))
    }

    await expect(client.startAuthMethod(authMethod as never, key, {})).rejects.toMatchObject({
      code: 'WAB_INVALID_RESPONSE'
    })
    await expect(client.completeAuthMethod(authMethod as never, key, {})).rejects.toMatchObject({
      code: 'WAB_INVALID_RESPONSE'
    })
  })

  it('validates linked-method rows and synthesizes the legacy HTTP-success verdict', async () => {
    const client = new WABClient('https://wab.example')
    const request = jest.spyOn(client.transport, 'request')
    const key = 'a'.repeat(64)
    request.mockResolvedValueOnce({
      authMethods: [{ id: 1, userId: 2, methodType: 'TwilioPhone', receivedFaucet: false }]
    } as never)

    await expect(client.listLinkedMethods(key)).resolves.toMatchObject({
      success: true,
      authMethods: [{ id: 1, methodType: 'TwilioPhone' }]
    })

    request.mockResolvedValueOnce({ authMethods: [{ id: 0, methodType: 'TwilioPhone' }] } as never)
    await expect(client.listLinkedMethods(key)).rejects.toMatchObject({ code: 'WAB_INVALID_RESPONSE' })
  })
})
