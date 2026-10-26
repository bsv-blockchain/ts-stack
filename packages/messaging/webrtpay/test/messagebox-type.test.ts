import { describe, expect, it } from '@jest/globals'
import type { MessageBoxClient } from '@bsv/message-box-client'
import type { MessageBoxLike } from '../src/signaling/MessageBoxSignaler.js'

describe('MessageBoxLike', () => {
  it('is satisfied by @bsv/message-box-client, live methods included', () => {
    // A compile-time check: typecheck fails if the client stops fitting.
    const fits = (c: MessageBoxClient): MessageBoxLike => c
    expect(typeof fits).toBe('function')
  })
})
