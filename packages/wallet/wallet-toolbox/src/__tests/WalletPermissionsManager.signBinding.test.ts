import { LockingScript, Transaction, UnlockingScript } from '@bsv/sdk'
import { WalletPermissionsManager } from '../WalletPermissionsManager'
import { WERR_INVALID_PARAMETER } from '../sdk/WERR_errors'

/**
 * signAction's binding of the wallet's final transaction to the authorized
 * template. The stand-in wallet does what the toolbox signer does: it applies
 * each spend's unlocking script and BRC-100 sequenceNumber, broadcasts, and
 * refuses to abort an action it has already sent.
 */

const REFERENCE = 'cmVmZXJlbmNl'
const ORIGINATOR = 'example.com'

function template(): Transaction {
  const source = new Transaction(1, [], [{ satoshis: 2, lockingScript: LockingScript.fromASM('OP_TRUE') }], 0)
  // The createAction draft: the caller's input is unsigned, its sequence the default.
  return new Transaction(
    1,
    [{ sourceTransaction: source, sourceOutputIndex: 0, sequence: 0xffffffff }],
    [{ satoshis: 1, lockingScript: LockingScript.fromASM('OP_TRUE') }],
    0
  )
}

interface StandIn {
  manager: any
  broadcasts: string[]
  signAction: jest.Mock
  abortAction: jest.Mock
}

function standIn(tamper: (tx: Transaction) => void = () => {}): StandIn {
  const broadcasts: string[] = []
  const signAction = jest.fn(
    async ({ spends }: { spends: Record<number, { unlockingScript: string; sequenceNumber?: number }> }) => {
      const tx = template()
      for (const [key, spend] of Object.entries(spends ?? {})) {
        const input = tx.inputs[Number(key)]
        if (input == null) continue
        input.unlockingScript = UnlockingScript.fromHex(spend.unlockingScript)
        if (spend.sequenceNumber !== undefined) input.sequence = spend.sequenceNumber
      }
      tamper(tx)
      const txid = tx.id('hex')
      broadcasts.push(txid)
      return { txid, tx: tx.toAtomicBEEF() }
    }
  )
  const abortAction = jest.fn(async () => {
    if (broadcasts.length > 0) {
      throw new WERR_INVALID_PARAMETER(
        'reference',
        'an inprocess, outgoing action that has not been signed and shared to the network.'
      )
    }
    return { aborted: true }
  })
  const manager = new WalletPermissionsManager({ signAction, abortAction } as never, 'admin.example', {
    encryptWalletMetadata: false,
    seekSpendingPermissions: false
  }) as any
  manager.pendingActionOriginators.set(REFERENCE, ORIGINATOR)
  manager.pendingActionTemplates.set(REFERENCE, template())
  return { manager, broadcasts, signAction, abortAction }
}

describe('WalletPermissionsManager signAction binding', () => {
  test("honours the caller's BRC-100 spends[vin].sequenceNumber", async () => {
    const { manager, broadcasts } = standIn()

    const result = await manager.signAction(
      { reference: REFERENCE, spends: { 0: { unlockingScript: '51', sequenceNumber: 0xfffffffe } } },
      ORIGINATOR
    )

    expect(broadcasts).toHaveLength(1)
    expect(result.txid).toBe(broadcasts[0])
    expect(Transaction.fromAtomicBEEF(result.tx).inputs[0].sequence).toBe(0xfffffffe)
  })

  test('still refuses a sequence the caller did not set', async () => {
    const { manager } = standIn(tx => {
      tx.inputs[0].sequence = 0xfffffffe
    })

    await expect(
      manager.signAction({ reference: REFERENCE, spends: { 0: { unlockingScript: '51' } } }, ORIGINATOR)
    ).rejects.toThrow('Wallet finalization substituted an authorized transaction input.')
  })

  test('still refuses a sequence other than the one the caller set', async () => {
    const { manager } = standIn(tx => {
      tx.inputs[0].sequence = 0
    })

    await expect(
      manager.signAction(
        { reference: REFERENCE, spends: { 0: { unlockingScript: '51', sequenceNumber: 0xfffffffe } } },
        ORIGINATOR
      )
    ).rejects.toThrow('Wallet finalization substituted an authorized transaction input.')
  })

  test.each([
    ['an input the template does not have', { 1: { unlockingScript: '51' } }, 'Signed input index is invalid.'],
    ['a non-canonical input index', { '00': { unlockingScript: '51' } }, 'Signed input index is invalid.'],
    [
      'an unlocking script that is not hex',
      { 0: { unlockingScript: 'not-hex' } },
      'Wallet finalization substituted an authorized unlocking script.'
    ],
    [
      'a sequence number outside uint32',
      { 0: { unlockingScript: '51', sequenceNumber: 2 ** 32 } },
      'Signed input sequence number is invalid.'
    ]
  ])('refuses a spend naming %s before the wallet signs or sends', async (_, spends, message) => {
    const { manager, broadcasts, signAction } = standIn()

    const error = await manager.signAction({ reference: REFERENCE, spends }, ORIGINATOR).catch((e: Error) => e)
    expect(signAction).not.toHaveBeenCalled()
    expect(broadcasts).toHaveLength(0)
    expect(error.message).toBe(message)
  })

  test("returns the binding's own error when the abort after a send fails", async () => {
    const { manager, broadcasts, abortAction } = standIn(tx => {
      tx.outputs[0].satoshis = 2
    })

    await expect(
      manager.signAction({ reference: REFERENCE, spends: { 0: { unlockingScript: '51' } } }, ORIGINATOR)
    ).rejects.toThrow('Wallet finalization substituted an authorized transaction output.')
    expect(broadcasts).toHaveLength(1)
    expect(abortAction).toHaveBeenCalledWith({ reference: REFERENCE })
    // The reference stays blocked: the caller cannot sign it again.
    await expect(
      manager.signAction({ reference: REFERENCE, spends: { 0: { unlockingScript: '51' } } }, ORIGINATOR)
    ).rejects.toThrow('This action was blocked after a failed authorization check.')
  })
})
