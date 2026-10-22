import { PrivateKey, ProtoWallet, PushDrop, Utils, type WalletInterface } from '@bsv/sdk'
import { decodeAndVerifyDiscoveryAdvertisement } from '../DiscoveryAdvertisementValidation'

const assetId = `${'0123456789abcdef'.repeat(4)}_0`

async function advertise(protocol: 'SHIP' | 'SLAP', name: string) {
  const wallet = new ProtoWallet(new PrivateKey(42))
  const { publicKey: identityKey } = await wallet.getPublicKey({ identityKey: true })
  return await new PushDrop(wallet as unknown as WalletInterface).lock(
    [
      Utils.toArray(protocol, 'utf8'),
      Utils.toArray(identityKey, 'hex'),
      Utils.toArray('https://example.com', 'utf8'),
      Utils.toArray(name, 'utf8')
    ],
    [2, protocol === 'SHIP' ? 'service host interconnect' : 'service lookup availability'],
    '1',
    'anyone',
    true
  )
}

describe('decodeAndVerifyDiscoveryAdvertisement names', () => {
  it.each([
    ['SHIP', 'tm_uhrp_files'],
    ['SHIP', `tm_color_${assetId}`],
    ['SLAP', 'ls_uhrp_files'],
    ['SLAP', `ls_color_${assetId}`],
    ['SHIP', 'tm_' + 'a'.repeat(253)]
  ] as const)('accepts %s advertisement for %s', async (protocol, name) => {
    const script = await advertise(protocol, name)
    await expect(decodeAndVerifyDiscoveryAdvertisement(script, protocol)).resolves.toMatchObject({
      protocol,
      domain: 'https://example.com',
      topicOrService: name
    })
  })

  it.each([
    ['SHIP', 'tm_'],
    ['SHIP', 'tm__x'],
    ['SHIP', 'tm_x_'],
    ['SHIP', 'tm_Color'],
    ['SHIP', 'tm_' + 'a'.repeat(297)],
    ['SHIP', `color_${assetId}`],
    ['SHIP', `ls_color_${assetId}`],
    ['SLAP', 'ls_'],
    ['SLAP', 'ls__x'],
    ['SLAP', 'ls_x_'],
    ['SLAP', 'ls_Color'],
    ['SLAP', 'ls_' + 'a'.repeat(297)],
    ['SLAP', `tm_color_${assetId}`]
  ] as const)('rejects %s advertisement for %s', async (protocol, name) => {
    const script = await advertise(protocol, name)
    await expect(decodeAndVerifyDiscoveryAdvertisement(script, protocol)).rejects.toThrow(
      'Discovery advertisement name is invalid'
    )
  })
})
