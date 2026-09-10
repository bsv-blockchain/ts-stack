import { WABClient } from '../WABClient'

describe('WABClient endpoint mapping', () => {
  it('maps every user and share operation to the bounded transport', async () => {
    const client = new WABClient('https://wab.example')
    const request = jest.spyOn(client.transport, 'request').mockResolvedValue({ success: true } as never)
    const key = 'a'.repeat(64)
    const phonePayload = { phoneNumber: ' +12065550100 ' }

    await client.listLinkedMethods(key)
    await client.unlinkMethod(key, 7)
    await client.requestFaucet(key)
    await client.finalizeRegistration(key)
    await client.deleteUser(key)
    await client.startShareAuth('TwilioPhone', key, phonePayload)
    await client.storeShare('TwilioPhone', phonePayload, 'share-b', key)
    await client.retrieveShare('TwilioPhone', phonePayload, key)
    await client.updateShare('TwilioPhone', phonePayload, key, 'new-share-b')
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
        shareB: 'share-b',
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
})
