import OverlayAdminTokenTemplate, {
  type OverlayDiscoveryProtocol
} from '../../overlay-tools/OverlayAdminTokenTemplate'
import PushDrop from '../../script/templates/PushDrop'
import { CompletedProtoWallet } from '../../auth/certificates/__tests/CompletedProtoWallet'
import { PrivateKey, Utils } from '../../primitives/index'
import { Transaction } from '../../transaction/index'
import { type LockingScript, Spend } from '../../script/index'

async function expectSpendable(
  template: OverlayAdminTokenTemplate,
  protocol: OverlayDiscoveryProtocol,
  lockingScript: LockingScript
): Promise<void> {
  const satoshis = 1
  const unlockingTemplate = template.unlock(protocol)
  const sourceTx = new Transaction(1, [], [{ lockingScript, satoshis }], 0)
  const spendTx = new Transaction(
    1,
    [
      {
        sourceTransaction: sourceTx,
        sourceOutputIndex: 0,
        sequence: 0xffffffff
      }
    ],
    [],
    0
  )
  const unlockingScript = await unlockingTemplate.sign(spendTx, 0)
  expect(await unlockingTemplate.estimateLength(spendTx, 0)).toEqual(73)
  const spend = new Spend({
    sourceTXID: sourceTx.id('hex'),
    sourceOutputIndex: 0,
    sourceSatoshis: satoshis,
    lockingScript,
    transactionVersion: 1,
    otherInputs: [],
    inputIndex: 0,
    unlockingScript,
    outputs: [],
    inputSequence: 0xffffffff,
    lockTime: 0
  })
  expect(spend.validate()).toBe(true)
}

describe('Overlay Admin Token Template', () => {
  describe('Lock and Decode', () => {
    it('creates a canonical publicly authenticated advertisement', async () => {
      const key = new PrivateKey(1)
      const wallet = new CompletedProtoWallet(key)
      const getPublicKey = jest.spyOn(wallet, 'getPublicKey')
      const createSignature = jest.spyOn(wallet, 'createSignature')
      const lib = new OverlayAdminTokenTemplate(wallet)
      const script = await lib.lock('SHIP', 'https://test.com', 'tm_tests')

      expect(OverlayAdminTokenTemplate.decode(script)).toEqual({
        domain: 'https://test.com',
        protocol: 'SHIP',
        identityKey: key.toPublicKey().toString(),
        topicOrService: 'tm_tests'
      })
      await expect(OverlayAdminTokenTemplate.decodeAndVerify(script, 'SHIP')).resolves.toEqual({
        domain: 'https://test.com',
        protocol: 'SHIP',
        identityKey: key.toPublicKey().toString(),
        topicOrService: 'tm_tests'
      })
      expect(
        getPublicKey.mock.calls.some(
          ([args]) =>
            args.protocolID?.[1] === 'service host interconnect' &&
            args.counterparty === 'anyone' &&
            args.forSelf === true
        )
      ).toBe(true)
      expect(
        createSignature.mock.calls.some(
          ([args]) =>
            args.protocolID?.[1] === 'service host interconnect' && args.counterparty === 'anyone'
        )
      ).toBe(true)
    })

    it('will not decode an invalid field count, protocol, URI, or name', async () => {
      const key = new PrivateKey(1)
      const wallet = new CompletedProtoWallet(key)
      const pushDrop = new PushDrop(wallet)
      const scriptBadFieldCount = await pushDrop.lock([[1], [2], [3]], [2, 'tests'], '1', 'self')
      const scriptBadProtocol = await pushDrop.lock([[1], [2], [3], [4]], [2, 'tests'], '1', 'self')
      expect(() => OverlayAdminTokenTemplate.decode(scriptBadFieldCount)).toThrow()
      expect(() => OverlayAdminTokenTemplate.decode(scriptBadProtocol)).toThrow()

      const identityCalls = jest.spyOn(wallet, 'getPublicKey')
      identityCalls.mockClear()
      const lib = new OverlayAdminTokenTemplate(wallet)
      await expect(lib.lock('SHIP', 'http://test.com', 'tm_tests')).rejects.toThrow(
        'URI is invalid'
      )
      await expect(lib.lock('SLAP', 'https://test.com', 'tm_tests')).rejects.toThrow(
        'topic or service name is invalid'
      )
      expect(identityCalls).not.toHaveBeenCalled()
    })

    it('rejects extra fields and forged signatures', async () => {
      const key = new PrivateKey(2)
      const wallet = new CompletedProtoWallet(key)
      const pushDrop = new PushDrop(wallet)
      const valid = await new OverlayAdminTokenTemplate(wallet).lock(
        'SLAP',
        'https://lookup.example',
        'ls_records'
      )
      const decoded = PushDrop.decode(valid)
      const extraField = await pushDrop.lock(
        [...decoded.fields.map(field => [...field]), [1]],
        [2, 'service lookup availability'],
        '1',
        'anyone',
        true,
        false
      )
      expect(() => OverlayAdminTokenTemplate.decode(extraField)).toThrow('field count')

      const forgedFields = decoded.fields.map(field => [...field])
      forgedFields[2] = Utils.toArray('https://attacker.example', 'utf8')
      const forged = await pushDrop.lock(
        forgedFields,
        [2, 'service lookup availability'],
        '1',
        'anyone',
        true,
        false
      )
      expect(OverlayAdminTokenTemplate.decode(forged).domain).toBe('https://attacker.example')
      await expect(OverlayAdminTokenTemplate.decodeAndVerify(forged, 'SLAP')).rejects.toThrow(
        'Signature is not valid'
      )
    })

    it('does not authenticate legacy self-derived advertisements', async () => {
      const key = new PrivateKey(3)
      const wallet = new CompletedProtoWallet(key)
      const legacy = await new PushDrop(wallet).lock(
        [
          Utils.toArray('SHIP', 'utf8'),
          Utils.toArray(key.toPublicKey().toString(), 'hex'),
          Utils.toArray('https://legacy.example', 'utf8'),
          Utils.toArray('tm_legacy', 'utf8')
        ],
        [2, 'Service Host Interconnect'],
        '1',
        'self'
      )
      expect(OverlayAdminTokenTemplate.decode(legacy).domain).toBe('https://legacy.example')
      await expect(OverlayAdminTokenTemplate.decodeAndVerify(legacy, 'SHIP')).rejects.toThrow()
    })
  })

  describe('Unlock', () => {
    it('spends a canonical advertisement', async () => {
      const wallet = new CompletedProtoWallet(new PrivateKey(4))
      const lib = new OverlayAdminTokenTemplate(wallet)
      const lockingScript = await lib.lock('SLAP', 'https://lookup.example', 'ls_tests')
      await expectSpendable(lib, 'SLAP', lockingScript)
    })

    it('retains spend compatibility for a legacy SDK advertisement', async () => {
      const key = new PrivateKey(5)
      const wallet = new CompletedProtoWallet(key)
      const lockingScript = await new PushDrop(wallet).lock(
        [
          Utils.toArray('SLAP', 'utf8'),
          Utils.toArray(key.toPublicKey().toString(), 'hex'),
          Utils.toArray('https://legacy.example', 'utf8'),
          Utils.toArray('ls_legacy', 'utf8')
        ],
        [2, 'Service Lookup Availability'],
        '1',
        'self'
      )
      await expectSpendable(new OverlayAdminTokenTemplate(wallet), 'SLAP', lockingScript)
    })

    it('refuses a source locked to another wallet', async () => {
      const owner = new CompletedProtoWallet(new PrivateKey(6))
      const other = new CompletedProtoWallet(new PrivateKey(7))
      const lockingScript = await new OverlayAdminTokenTemplate(owner).lock(
        'SHIP',
        'https://ship.example',
        'tm_tests'
      )
      await expect(
        expectSpendable(new OverlayAdminTokenTemplate(other), 'SHIP', lockingScript)
      ).rejects.toThrow('not locked to this wallet')
    })
  })
})
