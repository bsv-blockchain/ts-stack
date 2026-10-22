import type { InternalizeActionResult } from '@bsv/sdk'
import type { Wallet } from '../../out/src/Wallet'
import type { StorageInternalizeActionResult } from '../../out/src/sdk/WalletStorage.interfaces'

type Result = Awaited<ReturnType<Wallet['internalizeAction']>>
type IsAny<T> = 0 extends 1 & T ? true : false
type Assert<T extends true> = T

/** The concrete wallet retains its existing richer result and SDK substitution. */
export type InternalizeActionResultChecks = [
  Assert<IsAny<Result> extends false ? true : false>,
  Assert<Result extends StorageInternalizeActionResult ? true : false>,
  Assert<Result extends InternalizeActionResult ? true : false>,
  Assert<IsAny<Result['isMerge']> extends false ? true : false>,
  Assert<Result['isMerge'] extends boolean ? true : false>,
  Assert<IsAny<Result['satoshis']> extends false ? true : false>,
  Assert<Result['satoshis'] extends number ? true : false>,
  Assert<Result['txid'] extends string ? true : false>
]
