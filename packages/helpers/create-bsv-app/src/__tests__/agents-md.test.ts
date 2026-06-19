// src/__tests__/agents-md.test.ts
import { describe, expect, test } from '@jest/globals'
import { renderAgentsMd } from '../agents-md'

describe('renderAgentsMd', () => {
  test('includes header, deps, and the wallet-login section', () => {
    const md = renderAgentsMd({ appName: 'demo', network: 'test', framework: 'react', capabilityIds: ['wallet-login'] })
    expect(md).toContain('# demo — agent guide')
    expect(md).toContain('react')
    expect(md).toContain('## Install dependencies')
    expect(md).toContain('@bsv/auth')
    expect(md).toContain('## wallet-login')
  })

  test('throws on unknown capability id', () => {
    expect(() => renderAgentsMd({ appName: 'demo', network: 'test', framework: 'express', capabilityIds: ['nope'] }))
      .toThrow(/unknown capability/i)
  })
})
