import { MessageBoxClient } from '@bsv/message-box-client'
import { describe, expect, it } from 'vitest'
import type { MessageBoxClientLike } from '../message-box.js'

/**
 * The real client satisfies the shape we accept.
 *
 * Mostly a compile-time check wearing a test's clothing: if
 * `@bsv/message-box-client` changes a signature the assignment below stops
 * type-checking and `pnpm typecheck` fails, without anyone needing a live host
 * or a funded wallet. There is no CI in this repo, so `pnpm typecheck` is
 * where the drift surfaces, not a pipeline.
 *
 * esbuild strips types, so that assignment is nothing at runtime. The
 * assertion below is therefore a separate, real check: it reaches into the
 * installed package and confirms the methods exist under the names this
 * backend calls. That catches a rename even in a release whose types drifted
 * with it. `@bsv/message-box-client` is a devDependency and this import is a
 * test-only value import; the library itself still imports nothing from it.
 */
describe('MessageBoxClientLike', () => {
  it('is satisfied by @bsv/message-box-client', () => {
    const conforms = (client: MessageBoxClient): MessageBoxClientLike => client
    expect(conforms).toBeTypeOf('function')
  })

  it('names methods the installed client actually has', () => {
    const required: Array<keyof MessageBoxClientLike> = [
      'sendMessage',
      'listMessages',
      'acknowledgeMessage'
    ]
    for (const method of required) {
      expect(MessageBoxClient.prototype[method]).toBeTypeOf('function')
    }
  })

  /**
   * The live half is optional on the type, so a missing method degrades to
   * polling instead of failing to compile. That makes this assertion the only
   * thing standing between a rename upstream and live delivery quietly never
   * turning on — the `live` option would accept, report once, and poll.
   */
  it('names the live-delivery methods the installed client actually has', () => {
    const live: Array<keyof MessageBoxClientLike> = [
      'initializeConnection',
      'listenForLiveMessages',
      'leaveRoom',
      'disconnectWebSocket',
      // The relay is driven by the sender, so this is half of live delivery,
      // not an optimisation: without it a live subscriber is never pushed to.
      'sendLiveMessage',
      'getJoinedRooms'
    ]
    for (const method of live) {
      expect(MessageBoxClient.prototype[method]).toBeTypeOf('function')
    }
  })
})
