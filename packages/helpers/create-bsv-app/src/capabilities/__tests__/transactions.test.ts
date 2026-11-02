import { describe, expect, test } from '@jest/globals'
import { LockingScript, P2PKH, PrivateKey, PublicKey, Transaction, Validation } from '@bsv/sdk'
import type { InternalizeActionArgs } from '@bsv/sdk'
import { TRANSACTIONS_SOURCE, TX_UTILS_SOURCE } from '../tx-core'
import { loadGenerated } from '../../__tests__/helpers/generated-module'
import { EXPLICIT_ANY } from '../../__tests__/helpers/explicit-any'

// Runs the emitted transactions.ts against the real @bsv/sdk and @bsv/wallet-helper and a validating stub wallet.

interface Summary {
  outputs: Array<{ data?: string[] }>
}
interface DerivedAddress {
  address: string
  derivationPrefix: string
  derivationSuffix: string
}
interface InternalizePaymentArgs {
  tx: number[]
  outputIndex: number
  derivationPrefix: string
  derivationSuffix: string
  senderIdentityKey?: string
  description?: string
}

const utils = loadGenerated(TX_UTILS_SOURCE) as {
  summarizeTransaction: (tx: Transaction) => Summary
}
const m = loadGenerated(TRANSACTIONS_SOURCE) as {
  dataScript: (fields: string[]) => LockingScript
  deriveAddress: (wallet: unknown, counterparty?: string) => Promise<DerivedAddress>
  internalizePayment: (wallet: unknown, args: InternalizePaymentArgs) => Promise<void>
}

// The fields carried by a data script, read back through txUtils' summary.
function readBack(script: LockingScript): string[] | undefined {
  const tx = new Transaction(1, [], [{ lockingScript: script, satoshis: 0 }])
  return utils.summarizeTransaction(tx).outputs.map(o => o.data)[0]
}

describe('dataScript', () => {
  test('is OP_FALSE OP_RETURN followed by the UTF-8 pushes', () => {
    const script = m.dataScript(['hello', 'wörld 🚀'])
    expect(script).toBeInstanceOf(LockingScript)
    expect(script.toHex().startsWith('006a')).toBe(true)
    expect(readBack(script)).toEqual(['hello', 'wörld 🚀'])
  })

  test('round-trips fields across push-size boundaries', () => {
    const fields = [
      '',
      'a'.repeat(75),
      'b'.repeat(76),
      'c'.repeat(255),
      'd'.repeat(256),
      'e'.repeat(70000)
    ]
    expect(readBack(m.dataScript(fields))).toEqual(fields)
  })

  test('rejects an empty list and non-string fields', () => {
    expect(() => m.dataScript([])).toThrow('fields must be a non-empty array')
    expect(() => m.dataScript(['a', 5 as unknown as string])).toThrow(
      'every field must be a string'
    )
  })
})

interface KeyRequest {
  protocolID?: [number, string]
  keyID?: string
  counterparty?: string
  forSelf?: boolean
  identityKey?: boolean
}

// A wallet that derives keys (one random key per distinct keyID, plus an identity key) and records
// internalizeAction after the same client-side validation the real WalletClient does.
function stubWallet(internalize: 'ok' | 'throws' = 'ok') {
  const derived = new Map<string, string>()
  const keyRequests: KeyRequest[] = []
  const identity = PrivateKey.fromRandom().toPublicKey()
  const internalized: InternalizeActionArgs[] = []
  const wallet = {
    getPublicKey: async (args: KeyRequest) => {
      keyRequests.push(args)
      if (args.identityKey === true) return { publicKey: identity.toString() }
      const keyID = args.keyID as string
      if (!derived.has(keyID)) derived.set(keyID, PrivateKey.fromRandom().toPublicKey().toString())
      return { publicKey: derived.get(keyID) as string }
    },
    internalizeAction: async (args: InternalizeActionArgs) => {
      Validation.validateInternalizeActionArgs(args)
      internalized.push(args)
      if (internalize === 'throws') throw new Error('wallet refused')
      return { accepted: true as const }
    }
  }
  return { wallet, derived, keyRequests, identity, internalized }
}

describe('deriveAddress', () => {
  test('returns the P2PKH address of the BRC-29 self key and the split derivation', async () => {
    const { wallet, derived, keyRequests } = stubWallet()
    const own = await m.deriveAddress(wallet)
    expect(keyRequests).toHaveLength(1)
    expect(keyRequests[0].protocolID).toEqual([2, '3241645161d8'])
    expect(keyRequests[0].counterparty).toBe('self')
    expect(keyRequests[0].forSelf).toBe(true)
    const keyID = keyRequests[0].keyID as string
    const [prefix, suffix] = keyID.split(' ')
    expect(prefix).toMatch(/./)
    expect(suffix).toMatch(/./)
    expect(own).toEqual({
      address: PublicKey.fromString(derived.get(keyID) as string).toAddress(),
      derivationPrefix: prefix,
      derivationSuffix: suffix
    })
  })
})

describe('deriveAddress with a payer as counterparty (invoice)', () => {
  test('derives with the payer key, forSelf true, and returns that key address', async () => {
    const { wallet, derived, keyRequests } = stubWallet()
    const payer = PrivateKey.fromRandom().toPublicKey().toString()
    const own = await m.deriveAddress(wallet, payer)
    expect(keyRequests).toHaveLength(1)
    expect(keyRequests[0].protocolID).toEqual([2, '3241645161d8'])
    expect(keyRequests[0].counterparty).toBe(payer)
    expect(keyRequests[0].forSelf).toBe(true)
    const keyID = keyRequests[0].keyID as string
    expect(keyID).toBe(`${own.derivationPrefix} ${own.derivationSuffix}`)
    expect(own.address).toBe(PublicKey.fromString(derived.get(keyID) as string).toAddress())
  })

  test('the invoice derivation matches what internalizePayment records for the same payer', async () => {
    const { wallet, keyRequests, internalized } = stubWallet()
    const payer = PrivateKey.fromRandom().toPublicKey().toString()
    const own = await m.deriveAddress(wallet, payer)
    await m.internalizePayment(wallet, {
      tx: paymentBytes(),
      outputIndex: 1,
      derivationPrefix: own.derivationPrefix,
      derivationSuffix: own.derivationSuffix,
      senderIdentityKey: payer
    })
    const remittance = internalized[0].outputs[0].paymentRemittance
    expect(remittance?.senderIdentityKey).toBe(keyRequests[0].counterparty)
    expect(`${remittance?.derivationPrefix} ${remittance?.derivationSuffix}`).toBe(
      keyRequests[0].keyID
    )
    expect(internalized[0].outputs[0].protocol).toBe('wallet payment')
  })

  test('rejects an invalid counterparty without touching the wallet', async () => {
    const { wallet, keyRequests, internalized } = stubWallet()
    await expect(m.deriveAddress(wallet, 'bob')).rejects.toThrow('counterparty must be')
    expect(keyRequests).toHaveLength(0)
    expect(internalized).toHaveLength(0)
  })
})

// AtomicBEEF bytes of a real transaction with a P2PKH output at index 1.
function paymentBytes(): number[] {
  const lock = (): LockingScript =>
    new P2PKH().lock(PrivateKey.fromRandom().toPublicKey().toAddress())
  return new Transaction(
    1,
    [],
    [
      { lockingScript: lock(), satoshis: 7 },
      { lockingScript: lock(), satoshis: 1000 }
    ]
  ).toAtomicBEEF()
}

describe('internalizePayment', () => {
  test('sends a wallet payment with the exact bytes, index and derivation, from your identity key', async () => {
    const { wallet, internalized, identity } = stubWallet()
    const tx = paymentBytes()
    await m.internalizePayment(wallet, {
      tx,
      outputIndex: 1,
      derivationPrefix: 'cHJl',
      derivationSuffix: 'c3Vm'
    })
    expect(internalized).toHaveLength(1)
    expect(internalized[0].tx).toEqual(tx)
    expect(internalized[0].outputs).toEqual([
      {
        outputIndex: 1,
        protocol: 'wallet payment',
        paymentRemittance: {
          derivationPrefix: 'cHJl',
          derivationSuffix: 'c3Vm',
          senderIdentityKey: identity.toString()
        }
      }
    ])
    // The default description passed the wallet's validation (5..2000 bytes).
    expect(internalized[0].description).toBe('Receive payment')
  })

  test('an explicit sender and description pass through without asking for the identity key', async () => {
    const { wallet, internalized, keyRequests } = stubWallet()
    const sender = PrivateKey.fromRandom().toPublicKey().toString()
    await m.internalizePayment(wallet, {
      tx: paymentBytes(),
      outputIndex: 0,
      derivationPrefix: 'cHJl',
      derivationSuffix: 'c3Vm',
      senderIdentityKey: sender,
      description: 'Payment from Bob'
    })
    expect(internalized[0].outputs[0].paymentRemittance?.senderIdentityKey).toBe(sender)
    expect(internalized[0].description).toBe('Payment from Bob')
    expect(keyRequests).toHaveLength(0)
  })

  test.each([-1, 1.5, NaN])(
    'rejects outputIndex=%j without calling the wallet',
    async outputIndex => {
      const { wallet, internalized, keyRequests } = stubWallet()
      await expect(
        m.internalizePayment(wallet, {
          tx: paymentBytes(),
          outputIndex,
          derivationPrefix: 'a',
          derivationSuffix: 'b'
        })
      ).rejects.toThrow('outputIndex must be a whole number, 0 or more')
      expect(internalized).toHaveLength(0)
      expect(keyRequests).toHaveLength(0)
    }
  )

  test('rejects an empty tx without calling the wallet', async () => {
    const { wallet, internalized, keyRequests } = stubWallet()
    await expect(
      m.internalizePayment(wallet, {
        tx: [],
        outputIndex: 0,
        derivationPrefix: 'a',
        derivationSuffix: 'b'
      })
    ).rejects.toThrow('tx must be the transaction bytes the wallet returned')
    expect(internalized).toHaveLength(0)
    expect(keyRequests).toHaveLength(0)
  })

  test('a wallet error propagates', async () => {
    const { wallet } = stubWallet('throws')
    await expect(
      m.internalizePayment(wallet, {
        tx: paymentBytes(),
        outputIndex: 1,
        derivationPrefix: 'cHJl',
        derivationSuffix: 'c3Vm'
      })
    ).rejects.toThrow('wallet refused')
  })
})

describe('emitted source', () => {
  test('exports exactly the building blocks', () => {
    expect(Object.keys(m).sort()).toEqual(
      [
        'Beef',
        'LockingScript',
        'OP',
        'P2PKH',
        'Script',
        'Transaction',
        'TransactionBuilder',
        'UnlockingScript',
        'Utils',
        'WalletP2PKH',
        'dataScript',
        'deriveAddress',
        'extractOpReturnData',
        'getScriptType',
        'internalizePayment',
        'isP2PKH'
      ].sort()
    )
    expect(TRANSACTIONS_SOURCE).toContain('export interface DerivedAddress')
    expect(TRANSACTIONS_SOURCE).toContain('export interface InternalizePaymentArgs')
  })

  test('avoids completeBoundAction, outputs[0] and explicit any', () => {
    expect(TRANSACTIONS_SOURCE).not.toContain('completeBoundAction')
    expect(TRANSACTIONS_SOURCE).not.toContain('outputs[0]')
    expect(TRANSACTIONS_SOURCE).not.toMatch(EXPLICIT_ANY)
  })
})
