import Capability from '../capability.js'

describe('Capability', () => {
  it('requires a non-empty title', () => {
    expect(() => new Capability({ title: '' })).toThrow('Capability requires a title')
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
})
