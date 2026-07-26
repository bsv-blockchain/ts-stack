import { resolveHttpPort } from '../runtime.js'

describe('resolveHttpPort', () => {
  it('defaults to the container-facing port', () => {
    expect(resolveHttpPort({})).toBe(8080)
  })

  it('prefers PORT and retains HTTP_PORT as a fallback', () => {
    expect(resolveHttpPort({ PORT: '9000', HTTP_PORT: '9001' })).toBe(9000)
    expect(resolveHttpPort({ HTTP_PORT: '9001' })).toBe(9001)
  })

  it.each(['0', '65536', '1.5', 'abc'])('rejects invalid PORT=%s', value => {
    expect(() => resolveHttpPort({ PORT: value })).toThrow(
      'PORT must be an integer between 1 and 65535.'
    )
  })
})
