import { WalletCore } from '../WalletCore'
import { WalletInterface } from '@bsv/sdk'

const VALID_KEY_1 = '030dbed53c3613c887ad36e8bde365c2e58f6196735a589cd09d6bc316fa550df4'
const WALLET_BALANCE_BASKET = '893b7646de0e1c9f741bd6e9169b76a8847ae34adef7bef1e6a285371206d2e8'
const outpoint = (n: number): string => `${n.toString(16).padStart(64, '0')}.0`

// Concrete subclass for testing
class TestWallet extends WalletCore {
  private mockClient: any

  constructor(mockClient: any, identityKey?: string) {
    super(identityKey ?? VALID_KEY_1)
    this.mockClient = mockClient
  }

  getClient(): WalletInterface {
    return this.mockClient as unknown as WalletInterface
  }
}

describe('WalletCore getBalance', () => {
  let mockClient: any

  beforeEach(() => {
    mockClient = {
      listOutputs: jest.fn()
    }
  })

  // ==========================================================================
  // Default (no basket) — uses specOpWalletBalance
  // ==========================================================================

  describe('default (wallet balance via specOp)', () => {
    it('should call listOutputs with specOpWalletBalance basket', async () => {
      mockClient.listOutputs.mockResolvedValue({ totalOutputs: 5000, outputs: [] })
      const wallet = new TestWallet(mockClient)

      await wallet.getBalance()

      expect(mockClient.listOutputs).toHaveBeenCalledWith({
        basket: WALLET_BALANCE_BASKET,
        limit: 1
      })
    })

    it('should return totalOutputs as totalSatoshis and spendableSatoshis', async () => {
      mockClient.listOutputs.mockResolvedValue({ totalOutputs: 12345, outputs: [] })
      const wallet = new TestWallet(mockClient)

      const result = await wallet.getBalance()

      expect(result.totalSatoshis).toBe(12345)
      expect(result.spendableSatoshis).toBe(12345)
      expect(result.totalOutputs).toBe(0)
      expect(result.spendableOutputs).toBe(0)
    })

    it('should return zero when wallet has no balance', async () => {
      mockClient.listOutputs.mockResolvedValue({ totalOutputs: 0, outputs: [] })
      const wallet = new TestWallet(mockClient)

      const result = await wallet.getBalance()

      expect(result.totalSatoshis).toBe(0)
      expect(result.spendableSatoshis).toBe(0)
    })

    it('should reject a response without an authoritative total', async () => {
      mockClient.listOutputs.mockResolvedValue({ outputs: [] })
      const wallet = new TestWallet(mockClient)

      await expect(wallet.getBalance()).rejects.toThrow('totalOutputs')
    })

    it('should handle large balances', async () => {
      const largeBal = 2100000000000000 // max BSV supply in sats
      mockClient.listOutputs.mockResolvedValue({ totalOutputs: largeBal, outputs: [] })
      const wallet = new TestWallet(mockClient)

      const result = await wallet.getBalance()

      expect(result.totalSatoshis).toBe(largeBal)
      expect(result.spendableSatoshis).toBe(largeBal)
    })
  })

  // ==========================================================================
  // With basket — iterates outputs
  // ==========================================================================

  describe('with basket parameter', () => {
    it('should call listOutputs with the given basket', async () => {
      mockClient.listOutputs.mockResolvedValue({ totalOutputs: 0, outputs: [] })
      const wallet = new TestWallet(mockClient)

      await wallet.getBalance('tokens')

      expect(mockClient.listOutputs).toHaveBeenCalledWith({
        basket: 'tokens',
        limit: 10000,
        offset: 0
      })
    })

    it('should sum satoshis from all outputs', async () => {
      mockClient.listOutputs.mockResolvedValue({
        totalOutputs: 3,
        outputs: [
          { satoshis: 100, spendable: true, outpoint: outpoint(1) },
          { satoshis: 200, spendable: true, outpoint: outpoint(2) },
          { satoshis: 300, spendable: true, outpoint: outpoint(3) }
        ]
      })
      const wallet = new TestWallet(mockClient)

      const result = await wallet.getBalance('my-basket')

      expect(result.totalSatoshis).toBe(600)
      expect(result.totalOutputs).toBe(3)
      expect(result.spendableSatoshis).toBe(600)
      expect(result.spendableOutputs).toBe(3)
    })

    it('should read every declared page instead of returning a partial balance', async () => {
      mockClient.listOutputs
        .mockResolvedValueOnce({
          totalOutputs: 2,
          outputs: [{ satoshis: 100, spendable: true, outpoint: outpoint(1) }]
        })
        .mockResolvedValueOnce({
          totalOutputs: 2,
          outputs: [{ satoshis: 250, spendable: false, outpoint: outpoint(2) }]
        })
      const wallet = new TestWallet(mockClient)

      await expect(wallet.getBalance('paged')).resolves.toEqual({
        totalSatoshis: 350,
        totalOutputs: 2,
        spendableSatoshis: 100,
        spendableOutputs: 1
      })
      expect(mockClient.listOutputs).toHaveBeenNthCalledWith(2, {
        basket: 'paged',
        limit: 10000,
        offset: 1
      })
    })

    it('should fail closed on duplicate outputs or a changing page total', async () => {
      mockClient.listOutputs
        .mockResolvedValueOnce({
          totalOutputs: 2,
          outputs: [{ satoshis: 100, spendable: true, outpoint: outpoint(1) }]
        })
        .mockResolvedValueOnce({
          totalOutputs: 2,
          outputs: [{ satoshis: 100, spendable: true, outpoint: outpoint(1) }]
        })
      const wallet = new TestWallet(mockClient)

      await expect(wallet.getBalance('duplicated')).rejects.toThrow('duplicate output')

      mockClient.listOutputs.mockReset()
      mockClient.listOutputs
        .mockResolvedValueOnce({
          totalOutputs: 2,
          outputs: [{ satoshis: 100, spendable: true, outpoint: outpoint(1) }]
        })
        .mockResolvedValueOnce({
          totalOutputs: 3,
          outputs: [{ satoshis: 100, spendable: true, outpoint: outpoint(2) }]
        })
      await expect(wallet.getBalance('changing')).rejects.toThrow('changed while')
    })

    it('should refuse an unbounded basket instead of returning a partial balance', async () => {
      mockClient.listOutputs.mockResolvedValue({ totalOutputs: 100001, outputs: [] })
      const wallet = new TestWallet(mockClient)

      await expect(wallet.getBalance('huge')).rejects.toThrow('more than 100000 outputs')
    })

    it('should separate spendable from non-spendable outputs', async () => {
      mockClient.listOutputs.mockResolvedValue({
        totalOutputs: 4,
        outputs: [
          { satoshis: 100, spendable: true, outpoint: outpoint(1) },
          { satoshis: 200, spendable: false, outpoint: outpoint(2) },
          { satoshis: 300, spendable: true, outpoint: outpoint(3) },
          { satoshis: 400, spendable: false, outpoint: outpoint(4) }
        ]
      })
      const wallet = new TestWallet(mockClient)

      const result = await wallet.getBalance('tokens')

      expect(result.totalSatoshis).toBe(1000)
      expect(result.totalOutputs).toBe(4)
      expect(result.spendableSatoshis).toBe(400)
      expect(result.spendableOutputs).toBe(2)
    })

    it('should return zero for empty basket', async () => {
      mockClient.listOutputs.mockResolvedValue({ totalOutputs: 0, outputs: [] })
      const wallet = new TestWallet(mockClient)

      const result = await wallet.getBalance('empty-basket')

      expect(result.totalSatoshis).toBe(0)
      expect(result.totalOutputs).toBe(0)
      expect(result.spendableSatoshis).toBe(0)
      expect(result.spendableOutputs).toBe(0)
    })

    it('should reject outputs with undefined satoshis', async () => {
      mockClient.listOutputs.mockResolvedValue({
        totalOutputs: 2,
        outputs: [
          { satoshis: 500, spendable: true, outpoint: outpoint(1) },
          { spendable: true, outpoint: outpoint(2) } // no satoshis field
        ]
      })
      const wallet = new TestWallet(mockClient)

      await expect(wallet.getBalance('tokens')).rejects.toThrow('satoshis')
    })

    it('should reject outputs without an explicit spendable verdict', async () => {
      mockClient.listOutputs.mockResolvedValue({
        totalOutputs: 2,
        outputs: [
          { satoshis: 100, outpoint: outpoint(1) }, // no spendable field
          { satoshis: 200, spendable: false, outpoint: outpoint(2) }
        ]
      })
      const wallet = new TestWallet(mockClient)

      await expect(wallet.getBalance('tokens')).rejects.toThrow('spendable')
    })

    it('should reject a response without totalOutputs', async () => {
      mockClient.listOutputs.mockResolvedValue({
        outputs: [
          { satoshis: 100, spendable: true, outpoint: outpoint(1) },
          { satoshis: 200, spendable: true, outpoint: outpoint(2) }
        ]
      })
      const wallet = new TestWallet(mockClient)

      await expect(wallet.getBalance('tokens')).rejects.toThrow('totalOutputs')
    })

    it('should reject a null result from listOutputs', async () => {
      mockClient.listOutputs.mockResolvedValue(null)
      const wallet = new TestWallet(mockClient)

      await expect(wallet.getBalance('tokens')).rejects.toThrow('Invalid listOutputs result')
    })

    it('should handle single output basket', async () => {
      mockClient.listOutputs.mockResolvedValue({
        totalOutputs: 1,
        outputs: [{ satoshis: 1, spendable: true, outpoint: outpoint(1) }]
      })
      const wallet = new TestWallet(mockClient)

      const result = await wallet.getBalance('dust')

      expect(result.totalSatoshis).toBe(1)
      expect(result.spendableSatoshis).toBe(1)
      expect(result.totalOutputs).toBe(1)
      expect(result.spendableOutputs).toBe(1)
    })

    it('should handle basket with all non-spendable outputs', async () => {
      mockClient.listOutputs.mockResolvedValue({
        totalOutputs: 2,
        outputs: [
          { satoshis: 500, spendable: false, outpoint: outpoint(1) },
          { satoshis: 300, spendable: false, outpoint: outpoint(2) }
        ]
      })
      const wallet = new TestWallet(mockClient)

      const result = await wallet.getBalance('locked')

      expect(result.totalSatoshis).toBe(800)
      expect(result.totalOutputs).toBe(2)
      expect(result.spendableSatoshis).toBe(0)
      expect(result.spendableOutputs).toBe(0)
    })
  })

  // ==========================================================================
  // Error handling
  // ==========================================================================

  describe('error handling', () => {
    it('should propagate errors from listOutputs', async () => {
      mockClient.listOutputs.mockRejectedValue(new Error('Network error'))
      const wallet = new TestWallet(mockClient)

      await expect(wallet.getBalance()).rejects.toThrow('Network error')
    })

    it('should propagate errors from listOutputs with basket', async () => {
      mockClient.listOutputs.mockRejectedValue(new Error('Basket not found'))
      const wallet = new TestWallet(mockClient)

      await expect(wallet.getBalance('bad-basket')).rejects.toThrow('Basket not found')
    })
  })
})
