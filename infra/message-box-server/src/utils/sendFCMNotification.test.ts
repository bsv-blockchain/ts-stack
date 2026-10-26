import { buildFCMMessage } from './sendFCMNotification.js'

describe('FCM notification confidentiality', () => {
  it('keeps caller-selected routing metadata out of visible notification text', () => {
    const message = buildFCMMessage('delivery-token', {
      title: 'New Message',
      messageId: 'private-routing-id',
      originator: 'private-originator'
    })
    const apnsPayload = message.apns?.payload
    if (apnsPayload == null) throw new Error('Expected APNS payload')

    expect(message.notification?.body).toBe('Open the app to view this message.')
    expect(apnsPayload.aps.alert).toEqual({
      title: 'New Message',
      body: 'Open the app to view this message.'
    })
    expect(JSON.stringify(message.notification)).not.toContain('private-routing-id')
    expect(JSON.stringify(apnsPayload.aps)).not.toContain('private-routing-id')
    expect(message.android?.data?.messageId).toBe('private-routing-id')
    expect(apnsPayload.messageId).toBe('private-routing-id')
  })
})
