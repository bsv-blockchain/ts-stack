/**
 * Coerce a value to Buffer if currently encoded as a string or
 * @param val Buffer or string or number[]. If string, encoding param applies. If number[], Buffer.from constructor is used.
 * @param encoding defaults to 'hex'. Only applies to val of type string
 * @returns input val if it is a Buffer or new Buffer from string val
 * @publicbody
 */
export function asBuffer(val: Buffer | string | number[], encoding?: BufferEncoding): Buffer {
  let b: Buffer
  if (Buffer.isBuffer(val)) b = val
  else if (typeof val === 'string') b = Buffer.from(val, encoding ?? 'hex')
  else b = Buffer.from(val)
  return b
}

/**
 * Coerce a value to an encoded string if currently a Buffer or number[]
 * @param val Buffer or string or number[]. If string, encoding param applies. If number[], Buffer.from constructor is used.
 * @param encoding defaults to 'hex'
 * @returns input val if it is a string; or if number[], first converted to Buffer then as Buffer; if Buffer encoded using `encoding`
 * @publicbody
 */
export function asString(val: Buffer | string | number[], encoding?: BufferEncoding): string {
  if (Array.isArray(val)) val = Buffer.from(val)
  return Buffer.isBuffer(val) ? val.toString(encoding ?? 'hex') : val
}

export function asArray(val: Buffer | string | number[], encoding?: BufferEncoding): number[] {
  let a: number[]
  if (Array.isArray(val)) a = val
  else if (Buffer.isBuffer(val)) a = Array.from(val)
  else a = Array.from(Buffer.from(val, encoding || 'hex'))
  return a
}
