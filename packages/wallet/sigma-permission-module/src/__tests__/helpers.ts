import type { SigmaOperation } from '../encoding.js'
import type { SigmaPermissionModule } from '../SigmaPermissionModule.js'

export const next = async (): Promise<never> => {
  throw new Error('underlying wallet must not be called')
}

/** Calls `encrypt` through the module with the usual test defaults. */
export const call = async (
  module: SigmaPermissionModule,
  operation: SigmaOperation,
  plaintext: unknown,
  overrides: Record<string, unknown> = {},
  request: { method?: string; originator?: unknown } = {}
): Promise<{ ciphertext: number[] }> =>
  await module.handleRequest(
    {
      method: request.method ?? 'encrypt',
      originator: (request.originator ?? 'app.example') as string,
      args: {
        protocolID: [0, 'p sigma ' + operation + ' example payout'],
        keyID: 'member 1',
        plaintext,
        ...overrides
      }
    },
    next
  )

export const observe = <T>(
  promise: Promise<T>
): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> =>
  promise.then(
    value => ({ ok: true as const, value }),
    error => ({ ok: false as const, error })
  )
