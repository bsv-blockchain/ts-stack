import type SpendVerifierInterface from '../script/SpendVerifierInterface.js'
import type BdkVerifierInterface from './BdkVerifierInterface.js'

/** Backend shape shared by transaction-graph and individual-Spend routing. */
export type ScriptVerificationBackend = BdkVerifierInterface & SpendVerifierInterface

// Keep verifier authority inside this module. A public global slot allowed any
// unrelated dependency to replace verification after the host configured it.
let registeredBackend: ScriptVerificationBackend | undefined

/** Installs a process/page-wide optional script backend. */
export function registerScriptVerificationBackend(backend: ScriptVerificationBackend): void {
  if (registeredBackend != null && registeredBackend !== backend) {
    throw new Error('A different script verification backend is already registered')
  }
  registeredBackend = backend
}

/** Removes `backend` if it is still the active optional implementation. */
export function unregisterScriptVerificationBackend(backend: ScriptVerificationBackend): void {
  if (registeredBackend === backend) registeredBackend = undefined
}

/** Returns the currently registered optional script backend, if any. */
export function scriptVerificationBackend(): ScriptVerificationBackend | undefined {
  return registeredBackend
}
