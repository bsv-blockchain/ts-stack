import { canonicalOutputJSON, Hash, Utils, type OutputJSONObject } from '@bsv/sdk'
import { lchAssert } from './errors.js'
import { toHex } from './hash.js'

/** Narrow structural view of a locally installed protected immutable-object
 * owner. @bsv/output-knowledge's native/browser object owners implement it.
 * This is never a remote provider's claim of protected custody.
 */
export interface LCHOverlayObjectCustody {
  readonly durability: 'durable'
  readonly configuration: {
    storeId: string
    recipient: string
    binding: OutputJSONObject
    maximumObjects: number
    maximumObjectBytes: number
  }
  reserve(id: string, binding: OutputJSONObject, maximumBytes: number): Promise<unknown>
  read(
    id: string,
    binding: OutputJSONObject
  ): Promise<
    | { state: 'absent' }
    | { state: 'reserved'; reservation: { maximumBytes: number } }
    | { state: 'stored'; bytes: Uint8Array; receipt: { maximumBytes: number } }
  >
  put(id: string, binding: OutputJSONObject, bytes: Uint8Array): Promise<unknown>
}
export function lchOverlayCustodyBinding(domainId: string): OutputJSONObject {
  return { format: 'lch-overlay-custody/1', domainId }
}
/** Two slots are reserved before money: complete accepted terms, and a positive
 * local verification receipt. The latter enables offline entitlement checks
 * without turning each playback into another online acquisition/chain query.
 */
export class LCHOverlayPaidCustody {
  private readonly configuration: string
  private readonly pins: (() => boolean)[]
  private constructor(
    private readonly objects: LCHOverlayObjectCustody,
    private readonly domainId: string,
    private readonly recipient: string,
    private readonly original: Uint8Array
  ) {
    this.original = original.slice()
    this.configuration = canonicalOutputJSON(objects.configuration)
    this.pins = ['reserve', 'read', 'put'].map(name => {
      const key = name as 'reserve' | 'read' | 'put',
        method = objects[key]
      return () => objects[key] === method
    })
    this.current()
  }
  private current(): void {
    lchAssert(
      this.objects.durability === 'durable' &&
        this.pins.every(check => check()) &&
        canonicalOutputJSON(this.objects.configuration) === this.configuration &&
        canonicalOutputJSON(this.objects.configuration.binding) ===
          canonicalOutputJSON(lchOverlayCustodyBinding(this.domainId)) &&
        this.objects.configuration.recipient === this.recipient &&
        this.objects.configuration.maximumObjects >= 2 &&
        this.objects.configuration.maximumObjectBytes >= Math.max(this.original.length, 16384),
      'ERR_LCH_LICENSE',
      'LCH custody installation differs or lacks complete reservation'
    )
  }
  private binding(role: string): OutputJSONObject {
    return { ...lchOverlayCustodyBinding(this.domainId), role }
  }
  private id(role: string): string {
    return Utils.toHex(
      Hash.sha256(Utils.toArray('lch-overlay-custody/1\0' + this.domainId + '\0' + role, 'utf8'))
    )
  }
  static async initialize(
    objects: LCHOverlayObjectCustody,
    domainId: string,
    recipient: string,
    original: Uint8Array
  ): Promise<LCHOverlayPaidCustody> {
    const custody = new LCHOverlayPaidCustody(objects, domainId, recipient, original)
    await objects.reserve(custody.id('original'), custody.binding('original'), original.length)
    custody.current()
    await objects.reserve(custody.id('verified'), custody.binding('verified'), 16384)
    custody.current()
    await objects.put(custody.id('original'), custody.binding('original'), original.slice())
    await custody.check()
    return custody
  }
  static async open(
    objects: LCHOverlayObjectCustody,
    domainId: string,
    recipient: string,
    original: Uint8Array
  ): Promise<LCHOverlayPaidCustody> {
    const custody = new LCHOverlayPaidCustody(objects, domainId, recipient, original)
    await custody.check()
    return custody
  }
  async check(): Promise<void> {
    this.current()
    const original = await this.objects.read(this.id('original'), this.binding('original'))
    this.current()
    lchAssert(
      original.state === 'stored' &&
        original.receipt.maximumBytes === this.original.length &&
        toHex(original.bytes) === toHex(this.original),
      'ERR_LCH_LICENSE',
      'Retained original LCH terms are missing or differ'
    )
    const verified = await this.objects.read(this.id('verified'), this.binding('verified'))
    this.current()
    lchAssert(
      verified.state !== 'absent' &&
        (verified.state === 'stored'
          ? verified.receipt.maximumBytes
          : verified.reservation.maximumBytes) === 16384,
      'ERR_LCH_LICENSE',
      'LCH verification reservation is missing or differs'
    )
  }
  async record(deliveredDigest: string): Promise<void> {
    await this.check()
    const bytes = new TextEncoder().encode(
      canonicalOutputJSON({
        version: 1,
        domainId: this.domainId,
        deliveredDigest
      })
    )
    await this.objects.put(this.id('verified'), this.binding('verified'), bytes)
    this.current()
  }
  async verified(deliveredDigest: string): Promise<boolean> {
    await this.check()
    const result = await this.objects.read(this.id('verified'), this.binding('verified'))
    this.current()
    return (
      result.state === 'stored' &&
      toHex(result.bytes) ===
        toHex(
          new TextEncoder().encode(
            canonicalOutputJSON({
              version: 1,
              domainId: this.domainId,
              deliveredDigest
            })
          )
        )
    )
  }
}
