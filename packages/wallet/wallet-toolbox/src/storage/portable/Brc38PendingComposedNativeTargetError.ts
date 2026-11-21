/** Routing DATA from the actual completed-target catalog reader. This is not
 * permission to activate a target: pending recovery independently acquires its
 * own inventory, source and authenticated candidate scopes. */
export class Brc38PendingComposedNativeTargetError extends Error {
  constructor(
    readonly importId: string,
    readonly bindingSha256: string
  ) {
    super('Current completed restart refuses pending target: no durable completed commit')
    this.name = 'Brc38PendingComposedNativeTargetError'
    Object.freeze(this)
  }

  static matches(value: unknown, importId: string, bindingSha256: string): boolean {
    return (
      value instanceof Brc38PendingComposedNativeTargetError &&
      value.importId === importId &&
      value.bindingSha256 === bindingSha256
    )
  }
}
