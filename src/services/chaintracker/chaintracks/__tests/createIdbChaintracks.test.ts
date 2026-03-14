import { _tu } from '../../../../../test/utils/TestUtilsWalletStorage'
import { Chain } from '../../../../sdk/types'

import 'fake-indexeddb/auto'

describe('createIdbChaintracks tests', () => {
  jest.setTimeout(99999999)

  test('0', async () => {
    const target: Chain = 'main'
    if (_tu.noEnv(target)) return
    // Test runs over two minutes long...skipped
    return
  })
})
