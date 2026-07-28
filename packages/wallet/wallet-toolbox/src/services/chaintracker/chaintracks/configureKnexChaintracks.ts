import type { Knex } from 'knex'

import type { Chain } from '../../../sdk'
import type { ChaintracksOptions } from './Api/ChaintracksApi'
import {
  type ChaintracksArgumentsTail,
  type CreatedChaintracks,
  type ResolvedDefaultChaintracksParams,
  resolveDefaultChaintracksArguments,
  startChaintracks,
  toDefaultChaintracksArguments
} from './configureChaintracksIngestors'

export type DefaultKnexChaintracksArguments = [
  chain: Chain,
  rootFolder?: string,
  knexConfig?: Knex.Config,
  ...options: ChaintracksArgumentsTail
]

export interface ResolvedDefaultKnexChaintracksParams extends ResolvedDefaultChaintracksParams {
  rootFolder: string
  knexConfig?: Knex.Config
}

export function resolveDefaultKnexChaintracksArguments (
  args: DefaultKnexChaintracksArguments
): ResolvedDefaultKnexChaintracksParams {
  const [chain, rootFolder = './data/', knexConfig, ...options] = args
  return {
    ...resolveDefaultChaintracksArguments([chain, ...options]),
    rootFolder,
    knexConfig
  }
}

export function toDefaultKnexChaintracksArguments (
  params: ResolvedDefaultKnexChaintracksParams
): DefaultKnexChaintracksArguments {
  const [chain, ...options] = toDefaultChaintracksArguments(params)
  return [chain, params.rootFolder, params.knexConfig, ...options]
}

export function createAndStartDefaultKnexChaintracks<TStorage extends ChaintracksOptions['storage']> (
  args: DefaultKnexChaintracksArguments,
  createOptions: (...args: DefaultKnexChaintracksArguments) => ChaintracksOptions
): CreatedChaintracks<TStorage> {
  const params = resolveDefaultKnexChaintracksArguments(args)
  const options = createOptions(...toDefaultKnexChaintracksArguments(params))
  return startChaintracks<TStorage>(params, options)
}
