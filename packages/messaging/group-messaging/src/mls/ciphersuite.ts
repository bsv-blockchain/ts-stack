import { getCiphersuiteFromName, getCiphersuiteImpl, type CiphersuiteImpl } from 'ts-mls'
import type { MlsCiphersuiteName } from '../types.js'

const cache = new Map<MlsCiphersuiteName, Promise<CiphersuiteImpl>>()

/**
 * Building a ciphersuite implementation imports HPKE and signature backends, so
 * it is cached: every group operation needs one, and two clients in one process
 * should share it.
 */
export const resolveCiphersuite = async (name: MlsCiphersuiteName): Promise<CiphersuiteImpl> => {
  const existing = cache.get(name)
  if (existing !== undefined) return existing
  // Evicted on failure so a transient backend import does not poison every
  // later MLS operation in the process; the cached promise is the one returned,
  // so the rejection always has a handler.
  const built = getCiphersuiteImpl(getCiphersuiteFromName(name)).catch((cause: unknown) => {
    cache.delete(name)
    throw cause
  })
  cache.set(name, built)
  return built
}
