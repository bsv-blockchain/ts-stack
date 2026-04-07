import { WalletCore } from '../WalletCore'
import { WalletInterface } from '@bsv/sdk'

const VALID_KEY_1 = '030dbed53c3613c887ad36e8bde365c2e58f6196735a589cd09d6bc316fa550df4'
const WALLET_BALANCE_BASKET = '893b7646de0e1c9f741bd6e9169b76a8847ae34adef7bef1e6a285371206d2e8'

// Concrete subclass for testing
class TestWallet extends WalletCore {
  private mockClient: any

  constructor (mockClient: any, identityKey?: string) {
    super(identityKey ?? VALID_KEY_1)
    this.mockClient = mockClient
  }

  getClient (): WalletInterface {
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

      expect(mockClient.listOutputs).toHaveBeenCalledWith({ basket: WALLET_BALANCE_BASKET })
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

    it('should handle undefined totalOutputs gracefully', async () => {
      mockClient.listOutputs.mockResolvedValue({ outputs: [] })
      const wallet = new TestWallet(mockClient)

      const result = await wallet.getBalance()

      expect(result.totalSatoshis).toBe(0)
      expect(result.spendableSatoshis).toBe(0)
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

      expect(mockClient.listOutputs).toHaveBeenCalledWith({ basket: 'tokens' })
    })

    it('should sum satoshis from all outputs', async () => {
      mockClient.listOutputs.mockResolvedValue({
        totalOutputs: 3,
        outputs: [
          { satoshis: 100, spendable: true, outpoint: 'a.0' },
          { satoshis: 200, spendable: true, outpoint: 'b.0' },
          { satoshis: 300, spendable: true, outpoint: 'c.0' }
        ]
      })
      const wallet = new TestWallet(mockClient)

      const result = await wallet.getBalance('my-basket')

      expect(result.totalSatoshis).toBe(600)
      expect(result.totalOutputs).toBe(3)
      expect(result.spendableSatoshis).toBe(600)
      expect(result.spendableOutputs).toBe(3)
    })

    it('should separate spendable from non-spendable outputs', async () => {
      mockClient.listOutputs.mockResolvedValue({
        totalOutputs: 4,
        outputs: [
          { satoshis: 100, spendable: true, outpoint: 'a.0' },
          { satoshis: 200, spendable: false, outpoint: 'b.0' },
          { satoshis: 300, spendable: true, outpoint: 'c.0' },
          { satoshis: 400, spendable: false, outpoint: 'd.0' }
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

    it('should handle outputs with undefined satoshis', async () => {
      mockClient.listOutputs.mockResolvedValue({
        totalOutputs: 2,
        outputs: [
          { satoshis: 500, spendable: true, outpoint: 'a.0' },
          { spendable: true, outpoint: 'b.0' } // no satoshis field
        ]
      })
      const wallet = new TestWallet(mockClient)

      const result = await wallet.getBalance('tokens')

      expect(result.totalSatoshis).toBe(500)
      expect(result.spendableSatoshis).toBe(500)
    })

    it('should treat outputs without spendable field as spendable', async () => {
      mockClient.listOutputs.mockResolvedValue({
        totalOutputs: 2,
        outputs: [
          { satoshis: 100, outpoint: 'a.0' }, // no spendable field
          { satoshis: 200, spendable: false, outpoint: 'b.0' }
        ]
      })
      const wallet = new TestWallet(mockClient)

      const result = await wallet.getBalance('tokens')

      expect(result.totalSatoshis).toBe(300)
      expect(result.totalOutputs).toBe(2)
      expect(result.spendableSatoshis).toBe(100)
      expect(result.spendableOutputs).toBe(1)
    })

    it('should use outputs array length as fallback for totalOutputs', async () => {
      mockClient.listOutputs.mockResolvedValue({
        outputs: [
          { satoshis: 100, spendable: true, outpoint: 'a.0' },
          { satoshis: 200, spendable: true, outpoint: 'b.0' }
        ]
      })
      const wallet = new TestWallet(mockClient)

      const result = await wallet.getBalance('tokens')

      expect(result.totalOutputs).toBe(2)
    })

    it('should handle null result from listOutputs', async () => {
      mockClient.listOutputs.mockResolvedValue(null)
      const wallet = new TestWallet(mockClient)

      const result = await wallet.getBalance('tokens')

      expect(result.totalSatoshis).toBe(0)
      expect(result.totalOutputs).toBe(0)
      expect(result.spendableSatoshis).toBe(0)
      expect(result.spendableOutputs).toBe(0)
    })

    it('should handle single output basket', async () => {
      mockClient.listOutputs.mockResolvedValue({
        totalOutputs: 1,
        outputs: [
          { satoshis: 1, spendable: true, outpoint: 'a.0' }
        ]
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
          { satoshis: 500, spendable: false, outpoint: 'a.0' },
          { satoshis: 300, spendable: false, outpoint: 'b.0' }
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
