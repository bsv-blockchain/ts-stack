import { ListCertificatesArgs } from '@bsv/sdk'
import { sdk } from '../../../src/index.client'
import { _tu, expectToThrowWERR, TestWalletNoSetup } from '../../utils/TestUtilsWalletStorage'

describe('listCertificates tests', () => {
  jest.setTimeout(99999999)

  const env = _tu.getEnv('test')
  const ctxs: TestWalletNoSetup[] = []

  beforeAll(async () => {
    if (env.runMySQL) ctxs.push(await _tu.createLegacyWalletMySQLCopy('listCertificatesTests'))
    ctxs.push(await _tu.createLegacyWalletSQLiteCopy('listCertificatesTests'))
  })

  afterAll(async () => {
    for (const ctx of ctxs) {
      await ctx.storage.destroy()
    }
  })

  test('0 invalid params', async () => {
    for (const { wallet } of ctxs) {
      const invalidArgs: ListCertificatesArgs[] = [
        {
          certifiers: ['thisisnotbase64'],
          types: []
        }
        // Oh so many things to test...
      ]

      for (const args of invalidArgs) {
        await expectToThrowWERR(sdk.WERR_INVALID_PARAMETER, () => wallet.listCertificates(args))
      }
    }
  })

  test('1 certifier', async () => {
    for (const { wallet } of ctxs) {
      const tcs: { args: ListCertificatesArgs; count: number }[] = [
        {
          args: {
            certifiers: ['02cf6cdf466951d8dfc9e7c9367511d0007ed6fba35ed42d425cc412fd6cfd4a17'],
            types: [],
            limit: 1
          },
          count: 4
        },
        {
          args: {
            certifiers: ['02CF6CDF466951D8DFC9E7C9367511D0007ED6FBA35ED42D425CC412FD6CFD4A17'],
            types: [],
            limit: 10
          },
          count: 4
        },
        {
          args: {
            certifiers: [
              '02CF6CDF466951D8DFC9E7C9367511D0007ED6FBA35ED42D425CC412FD6CFD4A17',
              '03db7f9011443a17080e90dd97e370f246940420b07e2195f783a2be186c019722'
            ],
            types: [],
            limit: 10
          },
          count: 5
        }
      ]

      for (const tc of tcs) {
        const r = await wallet.listCertificates(tc.args)
        expect(r.certificates.length).toBe(Math.min(tc.args.limit!, tc.count))
        expect(r.totalCertificates).toBe(tc.count)
      }
    }
  })

  test('2 types', async () => {
    for (const { wallet } of ctxs) {
      const tcs: { args: ListCertificatesArgs; count: number }[] = [
        {
          args: {
            certifiers: [],
            types: ['exOl3KM0dIJ04EW5pZgbZmPag6MdJXd3/a1enmUU/BA='],
            limit: 1
          },
          count: 2
        },
        {
          args: {
            certifiers: [],
            types: ['exOl3KM0dIJ04EW5pZgbZmPag6MdJXd3/a1enmUU/BA='],
            limit: 10
          },
          count: 2
        },
        {
          args: {
            certifiers: [],
            types: [
              'exOl3KM0dIJ04EW5pZgbZmPag6MdJXd3/a1enmUU/BA=',
              'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=',
              'K94Qt3QJVntql3RVjl9hNmyNT2LweP8x+K+s7lJUg60='
            ],
            limit: 10
          },
          count: 9
        }
      ]

      for (const tc of tcs) {
        const r = await wallet.listCertificates(tc.args)
        expect(r.certificates.length).toBe(Math.min(tc.args.limit!, tc.count))
        expect(r.totalCertificates).toBe(tc.count)
      }
    }
  })
})
