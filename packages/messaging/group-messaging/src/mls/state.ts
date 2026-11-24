import { decodeGroupState, encodeGroupState, type ClientState } from 'ts-mls'
import type { MlsCiphersuiteName } from '../types.js'
import { clientConfigFor } from './authentication.js'
import { decodeExactly } from './codec.js'

/** Serialize a group's state for storage. Contains long-term secrets. */
export const encodeState = (state: ClientState): Uint8Array => encodeGroupState(state)

/**
 * Restore a group's state and re-attach this library's client configuration.
 *
 * `decodeGroupState` returns a `GroupState`, which carries no `clientConfig`.
 * Re-attaching it is not optional: without it the restored state falls back to
 * `ts-mls`'s permissive authentication service and credential binding silently
 * stops being enforced for the rest of that session.
 *
 * `ciphersuite` must be the caller's configured suite, never one read out of an
 * incoming credential or message — a credential must not get to choose the
 * authority that validates it.
 */
export const decodeState = (bytes: Uint8Array, ciphersuite: MlsCiphersuiteName): ClientState => {
  const decoded = decodeExactly(decodeGroupState, bytes, 'group state')
  return { ...decoded, clientConfig: clientConfigFor(ciphersuite) }
}
