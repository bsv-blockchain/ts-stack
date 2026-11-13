const { Buffer } = require('node:buffer')

test('intrinsic bindings retain realm identity, spies and replaceable host capabilities', () => {
  for (const [name, value] of Object.entries({ Math, String, Number, Object, Array, Reflect })) {
    expect(value).toBe(globalThis[name])
  }
  expect(Object.getPrototypeOf({})).toBe(Object.prototype)
  expect(Object.getPrototypeOf([])).toBe(Array.prototype)
  expect(Buffer).toBe(globalThis.Buffer)
  expect(new Uint8Array(1)).toBeInstanceOf(globalThis.Uint8Array)
  const original = Number.isSafeInteger
  const spy = jest.spyOn(Number, 'isSafeInteger')
  try {
    expect(globalThis.Number.isSafeInteger).toBe(spy)
    expect(Number.isSafeInteger(3)).toBe(true)
    expect(spy).toHaveBeenCalledWith(3)
  } finally {
    spy.mockRestore()
  }
  expect(Number.isSafeInteger).toBe(original)
  try {
    jest.useFakeTimers({ now: 123456 })
    expect(Date).toBe(globalThis.Date)
    expect(Date.now()).toBe(123456)
  } finally {
    jest.useRealTimers()
  }
  const originalFetch = globalThis.fetch
  const originalWasm = globalThis.WebAssembly
  try {
    const marker = () => Promise.reject(new Error('synthetic offline host'))
    globalThis.fetch = marker
    globalThis.WebAssembly = undefined
    expect(fetch).toBe(marker)
    expect(WebAssembly).toBeUndefined()
  } finally {
    globalThis.fetch = originalFetch
    globalThis.WebAssembly = originalWasm
  }
})
