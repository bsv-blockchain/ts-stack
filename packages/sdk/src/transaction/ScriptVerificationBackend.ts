import type SpendVerifierInterface from '../script/SpendVerifierInterface.js'
import type BdkVerifierInterface from './BdkVerifierInterface.js'

/** Backend shape shared by transaction-graph and individual-Spend routing. */
export type ScriptVerificationBackend =
  BdkVerifierInterface & SpendVerifierInterface

interface OptionalBackendGlobal {
  __bsvSdkScriptVerificationBackendV1?: ScriptVerificationBackend
}

function backendGlobal (): typeof globalThis & OptionalBackendGlobal {
  return globalThis as typeof globalThis & OptionalBackendGlobal
}

/** Installs a process/page-wide optional script backend. */
export function registerScriptVerificationBackend (
  backend: ScriptVerificationBackend
): void {
  backendGlobal().__bsvSdkScriptVerificationBackendV1 = backend
}

/** Removes `backend` if it is still the active optional implementation. */
export function unregisterScriptVerificationBackend (
  backend: ScriptVerificationBackend
): void {
  const registry = backendGlobal()
  if (registry.__bsvSdkScriptVerificationBackendV1 === backend) {
    delete registry.__bsvSdkScriptVerificationBackendV1
  }
}

/** Returns the currently registered optional script backend, if any. */
export function scriptVerificationBackend (): ScriptVerificationBackend | undefined {
  return backendGlobal().__bsvSdkScriptVerificationBackendV1
}
