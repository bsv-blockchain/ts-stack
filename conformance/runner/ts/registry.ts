/**
 * Central routing table for the BSV conformance runner.
 *
 * Usage:
 *   const route = routeForCategory('sha256')
 *   // route.domain === 'sdk'
 *   // route.dispatch === sdkDispatch
 *
 * Routing rules (in priority order):
 *   1. Direct file-basename match in a dispatcher's categories list.
 *   2. Top-level vector id prefix match (e.g. 'wallet.brc100.*' → wallet).
 *
 * Every category present in conformance/vectors/ MUST resolve to a dispatcher.
 * Categories that are not yet implemented throw 'not implemented' from their
 * dispatcher stub; that is intentional.
 */

import * as sdk from './dispatchers/sdk.js'
import * as wallet from './dispatchers/wallet.js'
import * as regressions from './dispatchers/regressions.js'
import * as auth from './dispatchers/auth.js'
import * as broadcast from './dispatchers/broadcast.js'
import * as messaging from './dispatchers/messaging.js'
import * as overlay from './dispatchers/overlay.js'
import * as payments from './dispatchers/payments.js'
import * as storage from './dispatchers/storage.js'
import * as sync from './dispatchers/sync.js'
import * as walletStorage from './dispatchers/wallet-storage.js'

export type DispatchFn = (
  category: string,
  input: Record<string, unknown>,
  expected: Record<string, unknown>
) => void | Promise<void>

export interface Route {
  domain: string
  dispatch: DispatchFn
}

// Build a lookup map from category → route.
// Dispatcher registration order determines precedence when there are overlaps
// (earlier wins); in practice categories are disjoint across dispatchers.
const DISPATCHERS: Array<{ domain: string; dispatcher: { categories: ReadonlyArray<string>; dispatch: DispatchFn } }> = [
  { domain: 'sdk',         dispatcher: sdk },
  // wallet.storage must come before wallet so adapter-conformance routes here, not to wallet.ts stub
  { domain: 'wallet.storage', dispatcher: walletStorage },
  { domain: 'wallet',      dispatcher: wallet },
  { domain: 'regressions', dispatcher: regressions },
  { domain: 'auth',        dispatcher: auth },
  { domain: 'broadcast',   dispatcher: broadcast },
  { domain: 'messaging',   dispatcher: messaging },
  { domain: 'overlay',     dispatcher: overlay },
  { domain: 'payments',    dispatcher: payments },
  { domain: 'storage',     dispatcher: storage },
  { domain: 'sync',        dispatcher: sync }
]

const CATEGORY_MAP = new Map<string, Route>()

for (const { domain, dispatcher } of DISPATCHERS) {
  for (const cat of dispatcher.categories) {
    if (!CATEGORY_MAP.has(cat)) {
      CATEGORY_MAP.set(cat, { domain, dispatch: dispatcher.dispatch })
    }
  }
}

// Prefix-based fallback: maps id-prefix segment → domain.
// Used when the file-basename alone is not sufficient (e.g. a category name
// that collides across domains, or a file not in the primary categories list).
const PREFIX_MAP: Array<[string, Route]> = [
  ['sdk.',             { domain: 'sdk',           dispatch: sdk.dispatch }],
  // wallet.storage. must come before wallet. so prefix-fallback routes correctly
  ['wallet.storage.',  { domain: 'wallet.storage', dispatch: walletStorage.dispatch }],
  ['wallet.',          { domain: 'wallet',         dispatch: wallet.dispatch }],
  ['regression.',      { domain: 'regressions',    dispatch: regressions.dispatch }],
  ['auth.',            { domain: 'auth',           dispatch: auth.dispatch }],
  ['broadcast.',       { domain: 'broadcast',      dispatch: broadcast.dispatch }],
  ['messaging.',       { domain: 'messaging',      dispatch: messaging.dispatch }],
  ['overlay.',         { domain: 'overlay',        dispatch: overlay.dispatch }],
  ['payments.',        { domain: 'payments',       dispatch: payments.dispatch }],
  ['storage.',         { domain: 'storage',        dispatch: storage.dispatch }],
  ['sync.',            { domain: 'sync',           dispatch: sync.dispatch }]
]

/**
 * Returns a { domain, dispatch } route for the given category, or null if no
 * dispatcher claims it.
 *
 * @param category - file-basename of the vector file (e.g. 'sha256', 'getpublickey')
 * @param vectorId - optional top-level vector file id (e.g. 'wallet.brc100.getpublickey')
 *                   used as fallback when basename match fails
 */
export function routeForCategory (category: string, vectorId?: string): Route | null {
  // 1. Direct basename match
  const direct = CATEGORY_MAP.get(category)
  if (direct !== undefined) return direct

  // 2. Id-prefix match (fallback)
  if (vectorId !== undefined) {
    for (const [prefix, route] of PREFIX_MAP) {
      if (vectorId.startsWith(prefix)) return route
    }
  }

  return null
}
