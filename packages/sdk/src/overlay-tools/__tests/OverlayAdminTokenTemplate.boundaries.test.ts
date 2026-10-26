import { CompletedProtoWallet } from '../../auth/certificates/__tests/CompletedProtoWallet'
import PrivateKey from '../../primitives/PrivateKey'
import LockingScript from '../../script/LockingScript'
import OverlayAdminTokenTemplate from '../OverlayAdminTokenTemplate'

describe('OverlayAdminTokenTemplate boundary validation', () => {
  const invalidURIs = [
    '',
    'https://localhost',
    'https://xn--bcher-kva.example',
    'https://user:secret@example.com',
    'https://example.com/path',
    'https://example.com/#fragment',
    'https://[',
    'wss://localhost/socket',
    'wss://user:secret@example.com/socket',
    'wss://example.com/socket#fragment',
    'wss://[',
    'js8c+bsvauth+smf:',
    'js8c+bsvauth+smf:?lat=1&long=2&freq=7MHz&radius=10km&extra=1',
    'js8c+bsvauth+smf:?lat=1&lat=2&long=2&freq=7MHz&radius=10km',
    'js8c+bsvauth+smf:?lat=1e1&long=2&freq=7MHz&radius=10km',
    'js8c+bsvauth+smf:?lat=91&long=2&freq=7MHz&radius=10km',
    'js8c+bsvauth+smf:?lat=1&long=-181&freq=7MHz&radius=10km',
    'js8c+bsvauth+smf:?lat=1&long=2&freq=0MHz&radius=10km',
    `js8c+bsvauth+smf:?lat=1&long=2&freq=${'9'.repeat(400)}MHz&radius=10km`,
    'js8c+bsvauth+smf:?lat=1&long=2&freq=7MHz&radius=none'
  ]

  it.each(invalidURIs)('rejects hostile or non-canonical URI %s', async uri => {
    const wallet = new CompletedProtoWallet(new PrivateKey(21))
    const identityCall = jest.spyOn(wallet, 'getPublicKey')

    await expect(
      new OverlayAdminTokenTemplate(wallet).lock('SHIP', uri, 'tm_security')
    ).rejects.toThrow('URI is invalid')
    expect(identityCall).not.toHaveBeenCalled()
  })

  it('rejects byte-oversized and control-bearing URIs before consulting the wallet', async () => {
    const wallet = new CompletedProtoWallet(new PrivateKey(22))
    const identityCall = jest.spyOn(wallet, 'getPublicKey')
    const template = new OverlayAdminTokenTemplate(wallet)

    await expect(
      template.lock('SHIP', `https://${'é'.repeat(2050)}.example`, 'tm_security')
    ).rejects.toThrow('URI is invalid')
    await expect(
      template.lock('SHIP', 'https://example.com/\u0000', 'tm_security')
    ).rejects.toThrow('URI is invalid')
    expect(identityCall).not.toHaveBeenCalled()
  })

  it.each([
    'https://example.com',
    'https+bsvauth://example.com',
    'https+bsvauth+smf://example.com',
    'https+bsvauth+scrypt-offchain://example.com',
    'https+rtt://example.com',
    'wss://example.com/socket',
    'js8c+bsvauth+smf:?lat=41.88&long=-87.63&freq=7.078MHz&radius=10km'
  ])('round-trips an allowed discovery transport URI %s', async uri => {
    const wallet = new CompletedProtoWallet(new PrivateKey(23))
    const script = await new OverlayAdminTokenTemplate(wallet).lock('SHIP', uri, 'tm_security')

    await expect(OverlayAdminTokenTemplate.decodeAndVerify(script)).resolves.toMatchObject({
      domain: uri,
      protocol: 'SHIP',
      topicOrService: 'tm_security'
    })
  })

  it('rejects a validly signed advertisement whose locking key belongs to another identity', async () => {
    const first = await new OverlayAdminTokenTemplate(
      new CompletedProtoWallet(new PrivateKey(24))
    ).lock('SHIP', 'https://ship.example', 'tm_security')
    const second = await new OverlayAdminTokenTemplate(
      new CompletedProtoWallet(new PrivateKey(25))
    ).lock('SHIP', 'https://other.example', 'tm_security')
    const forged = new LockingScript(
      first.chunks.map(chunk => ({ ...chunk, data: chunk.data?.slice() }))
    )
    forged.chunks[0].data = second.chunks[0].data?.slice()

    await expect(OverlayAdminTokenTemplate.decodeAndVerify(forged, 'SHIP')).rejects.toThrow(
      'locking key is not linked to its identity'
    )
  })

  it('rejects truncated field signatures before cryptographic verification', async () => {
    const script = await new OverlayAdminTokenTemplate(
      new CompletedProtoWallet(new PrivateKey(26))
    ).lock('SLAP', 'https://lookup.example', 'ls_security')
    const truncated = new LockingScript(
      script.chunks.map(chunk => ({ ...chunk, data: chunk.data?.slice() }))
    )
    truncated.chunks[6] = { op: 0x51 }

    expect(() => OverlayAdminTokenTemplate.decode(truncated)).toThrow('signature is invalid')
  })

  it.each([
    ['SHIP', `tm_color_${'0123456789abcdef'.repeat(4)}_0`],
    ['SHIP', 'tm_uhrp_files'],
    ['SLAP', `ls_color_${'0123456789abcdef'.repeat(4)}_0`],
    ['SLAP', 'ls_uhrp_files']
  ] as const)('round-trips a %s advertisement for %s', async (protocol, name) => {
    const wallet = new CompletedProtoWallet(new PrivateKey(29))
    const script = await new OverlayAdminTokenTemplate(wallet).lock(
      protocol,
      'https://example.com',
      name
    )

    await expect(
      OverlayAdminTokenTemplate.decodeAndVerify(script, protocol)
    ).resolves.toMatchObject({ protocol, topicOrService: name })
  })

  it.each([
    ['SHIP', 'tm__x'],
    ['SHIP', 'tm_x_'],
    ['SHIP', 'tm_Color'],
    ['SHIP', 'tm_' + 'a'.repeat(297)],
    ['SHIP', `color_${'0123456789abcdef'.repeat(4)}_0`],
    ['SHIP', `ls_color_${'0123456789abcdef'.repeat(4)}_0`],
    ['SLAP', 'ls_'],
    ['SLAP', 'ls__x'],
    ['SLAP', 'ls_x_'],
    ['SLAP', 'ls_Color'],
    ['SLAP', 'ls_' + 'a'.repeat(297)],
    ['SLAP', `tm_color_${'0123456789abcdef'.repeat(4)}_0`]
  ] as const)('refuses to lock a %s advertisement for %s', async (protocol, name) => {
    const wallet = new CompletedProtoWallet(new PrivateKey(30))
    const identityCall = jest.spyOn(wallet, 'getPublicKey')
    await expect(
      new OverlayAdminTokenTemplate(wallet).lock(protocol, 'https://example.com', name)
    ).rejects.toThrow('topic or service name is invalid')
    expect(identityCall).not.toHaveBeenCalled()
  })

  it('rejects invalid runtime protocols and malformed names before wallet use', async () => {
    const wallet = new CompletedProtoWallet(new PrivateKey(27))
    const identityCall = jest.spyOn(wallet, 'getPublicKey')
    const template = new OverlayAdminTokenTemplate(wallet)

    await expect(
      template.lock('OTHER' as never, 'https://example.com', 'tm_security')
    ).rejects.toThrow('must be SHIP or SLAP')
    await expect(template.lock('SHIP', 'https://example.com', 'tm_')).rejects.toThrow(
      'topic or service name is invalid'
    )
    expect(identityCall).not.toHaveBeenCalled()
  })

  it('fails closed when the wallet-produced advertisement differs from the request', async () => {
    const wallet = new CompletedProtoWallet(new PrivateKey(28))
    const template = new OverlayAdminTokenTemplate(wallet)
    const verify = jest.spyOn(OverlayAdminTokenTemplate, 'decodeAndVerify').mockResolvedValueOnce({
      protocol: 'SHIP',
      identityKey: new PrivateKey(28).toPublicKey().toString(),
      domain: 'https://substituted.example',
      topicOrService: 'tm_security'
    })

    await expect(template.lock('SHIP', 'https://example.com', 'tm_security')).rejects.toThrow(
      'does not match the requested data'
    )
    verify.mockRestore()
  })
})
