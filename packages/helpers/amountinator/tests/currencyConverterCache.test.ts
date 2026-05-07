import { CurrencyConverter } from '../src/utils/currencyConverter'

const getBsvExchangeRateMock = jest.fn()
const getFiatExchangeRatesMock = jest.fn()

jest.mock('@bsv/wallet-toolbox-client', () => ({
    Services: jest.fn().mockImplementation(() => ({
        getBsvExchangeRate: getBsvExchangeRateMock,
        getFiatExchangeRates: getFiatExchangeRatesMock
    }))
}))

jest.mock(
    '@bsv/wallet-toolbox-client/out/src/WalletSettingsManager',
    () => ({
        WalletSettingsManager: jest.fn().mockImplementation(() => ({
            get: jest.fn().mockResolvedValue({ currency: 'USD' })
        }))
    })
)

describe('CurrencyConverter cache behaviour', () => {
    let cc: CurrencyConverter

    beforeEach(() => {
        jest.useFakeTimers()
        jest.setSystemTime(new Date('2024-01-01T00:00:00.000Z'))
        jest.clearAllMocks()

        // first call returns 62 USD/BSV, later calls would return 100
        getBsvExchangeRateMock
            .mockResolvedValueOnce(62)
            .mockResolvedValue(100)

        // fiat rates are fine staying constant for this test
        getFiatExchangeRatesMock.mockResolvedValue({
            timestamp: new Date(),
            base: 'USD',
            rates: {}
        })
    })

    afterEach(() => {
        cc?.dispose?.()
        jest.clearAllTimers()
        jest.useRealTimers()
    })

    test('uses cached exchange rate inside 5-minute window', async () => {
        cc = new CurrencyConverter()
        await cc.initialize()

        const first = await cc.convertAmount('10000')
        
        jest.advanceTimersByTime(1000)
        
        const second = await cc.convertAmount('10000')
        
        expect(first.hoverText).toBe('$0.0062')
        expect(second.hoverText).toBe('$0.0062')
        expect(getBsvExchangeRateMock).toHaveBeenCalledTimes(1)
    })

    test('checks if the chache is set to 0 if it refreshes or not', async () => {
        cc = new CurrencyConverter(0)
        await cc.initialize()

        const first = await cc.convertAmount('10000')
        
        jest.advanceTimersByTime(1000)
        
        const second = await cc.convertAmount('10000')
        
        expect(first.hoverText).toBe('$0.0062')
        expect(second.hoverText).toBe('$0.0062')
        expect(getBsvExchangeRateMock).toHaveBeenCalledTimes(1)
    })

    test('checks if the chache will properly reset itself', async () => {
        cc = new CurrencyConverter(500)
        await cc.initialize()

        
        const first = await cc.convertAmount('10000')
        const second = await cc.convertAmount('5000')

        await jest.advanceTimersByTimeAsync(500)
        
        const third = await cc.convertAmount('10000')
        
        expect(first.hoverText).toBe('$0.0062')
        expect(second.hoverText).toBe('$0.0031')
        expect(third.hoverText).not.toBe('$0.0062')
        expect(getBsvExchangeRateMock).toHaveBeenCalledTimes(2)
    })
})
