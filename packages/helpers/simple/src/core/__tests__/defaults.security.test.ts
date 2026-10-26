import { mergeDefaults } from '../defaults'

describe('wallet default own-data boundaries', () => {
  afterEach(() => {
    for (const key of ['registryFetch', 'didFetch', 'didProxyUrl']) {
      Reflect.deleteProperty(Object.prototype, key)
    }
  })

  it('ignores inherited transport overrides before and after construction', () => {
    const registryFetch = jest.fn()
    const didFetch = jest.fn()
    Object.defineProperties(Object.prototype, {
      registryFetch: { value: registryFetch, configurable: true },
      didFetch: { value: didFetch, configurable: true },
      didProxyUrl: { value: 'https://ambient.invalid', configurable: true }
    })

    const defaults = mergeDefaults({})
    expect(Object.getPrototypeOf(defaults)).toBeNull()
    expect('registryFetch' in defaults).toBe(false)
    expect('didFetch' in defaults).toBe(false)
    expect('didProxyUrl' in defaults).toBe(false)

    Reflect.deleteProperty(Object.prototype, 'registryFetch')
    Reflect.deleteProperty(Object.prototype, 'didFetch')
    Reflect.deleteProperty(Object.prototype, 'didProxyUrl')
    Object.defineProperty(Object.prototype, 'registryFetch', {
      value: jest.fn(),
      configurable: true
    })
    expect('registryFetch' in defaults).toBe(false)
  })

  it('clones protocol tuples and rejects accessor-backed configuration without invoking it', () => {
    const tokenProtocolID: [0, string] = [0, 'custom-token']
    const defaults = mergeDefaults({ tokenProtocolID })
    tokenProtocolID[1] = 'mutated'
    expect(defaults.tokenProtocolID).toEqual([0, 'custom-token'])

    const getter = jest.fn(() => jest.fn())
    const accessorConfig = Object.defineProperty({}, 'registryFetch', {
      get: getter,
      enumerable: true
    })
    expect(() => mergeDefaults(accessorConfig)).toThrow('plain own-data object')
    expect(getter).not.toHaveBeenCalled()
  })
})
