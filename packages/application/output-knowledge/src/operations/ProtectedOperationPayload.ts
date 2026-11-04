import type { OutputJSONObject } from '@bsv/sdk'
/** Installed local confidentiality/integrity capability; never an authorization decision. */
export interface ProtectedOperationPayload {
  readonly id: string
  readonly maximumPlaintextBytes: number
  /** Includes the complete JSON representation returned by seal, including base64 overhead. */
  readonly maximumSealedBytes: number
  seal(binding: OutputJSONObject, plaintext: Uint8Array): Promise<OutputJSONObject>
  open(binding: OutputJSONObject, envelope: unknown): Promise<Uint8Array>
}
