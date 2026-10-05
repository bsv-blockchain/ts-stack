interface BoundActionOutputAuthorization {
  outputIndex: number
  lockingScript: string
  satoshis: number
}

// Internal cooperation between trusted local signer/permission code, not a
// sandbox for executable plugins. Remote BRC-100 fields and serialized results
// cannot populate this private registry; labels alone never confer authority.
const authorizations = new WeakMap<object, ReadonlyArray<Readonly<BoundActionOutputAuthorization>>>()
const get = WeakMap.prototype.get
const set = WeakMap.prototype.set
const apply = Reflect.apply

export function setActionOutputAuthorizations(
  result: object,
  outputs: ReadonlyArray<BoundActionOutputAuthorization>
): void {
  apply(set, authorizations, [result, outputs.map(output => Object.freeze({ ...output }))])
}

export function getActionOutputAuthorizations(result: object): BoundActionOutputAuthorization[] {
  const outputs = apply(get, authorizations, [result]) as ReadonlyArray<BoundActionOutputAuthorization> | undefined
  return outputs == null ? [] : outputs.map(output => ({ ...output }))
}

export function copyActionOutputAuthorizations(source: object, target: object): void {
  const outputs = apply(get, authorizations, [source]) as ReadonlyArray<BoundActionOutputAuthorization> | undefined
  if (outputs != null) apply(set, authorizations, [target, outputs])
}
