import Capability from '../capability.js'

describe('Capability', () => {
  it('requires a non-empty title', () => {
    expect(() => new Capability({ title: '' })).toThrow('Capability requires a non-empty title')
  })

  it('generates a stable BFRC identifier and defaults to GET', () => {
    const first = new Capability({
      title: 'Example capability',
      authors: ['Alice', 'Bob'],
      version: '1'
    })
    const second = new Capability({
      title: 'Example capability',
      authors: ['Alice', 'Bob'],
      version: '1'
    })

    expect(first.getCode()).toMatch(/^[0-9a-f]{12}$/)
    expect(second.getCode()).toBe(first.getCode())
    expect(first.getMethod()).toBe('GET')
  })

  it('preserves explicit identifiers and methods', () => {
    const capability = new Capability({
      code: 'example',
      title: 'Example capability',
      method: 'POST'
    })

    expect(capability.getCode()).toBe('example')
    expect(capability.getMethod()).toBe('POST')
  })

  it('snapshots caller-owned metadata before deriving its identifier', () => {
    const authors = ['Alice']
    const supersedes = ['previous']
    const capability = new Capability({
      title: 'Immutable capability',
      authors,
      supersedes,
      version: '1'
    })
    const code = capability.getCode()

    authors[0] = 'Mallory'
    supersedes[0] = '__proto__'

    expect(capability.getCode()).toBe(code)
  })

  it('rejects malformed runtime metadata and unsafe explicit identifiers', () => {
    expect(() => new Capability({ title: 7 as unknown as string })).toThrow(
      'Capability requires a non-empty title'
    )
    expect(
      () => new Capability({ title: 'Example', authors: 'Alice' as unknown as string[] })
    ).toThrow('Capability authors must be an array')
    expect(() => new Capability({ title: 'Example', method: 'PUT' as 'GET' })).toThrow(
      'Capability method must be GET or POST'
    )
    expect(() => new Capability({ title: 'Example', code: '__proto__' })).toThrow(
      'Capability code is invalid'
    )
  })
})
