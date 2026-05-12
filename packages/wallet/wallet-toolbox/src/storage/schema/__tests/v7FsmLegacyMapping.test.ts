import * as sdk from '../../../sdk'
import { isValidProcessingTransition } from '../v7Fsm'

/**
 * Verifies that every legacy-mapped transition required by
 * `docs/V7_STORAGE_METHOD_WIRING.md` §4 resolves to a permitted V7
 * `ProcessingStatus` transition.
 *
 * The placeholder names in the analysis doc ("broadcasting", "broadcasted")
 * map to the real V7 states `sending` (in flight) and `sent` (handed off /
 * accepted by at least one provider). `seen` is the post-broadcast confirmed-
 * by-network state; we cover both `sent` and `seen` as legitimate
 * "broadcasted" targets per the FSM design comment in `v7Fsm.ts`.
 *
 * If this table changes, update the §4 mapping in the wiring doc in lockstep.
 */
interface LegacyMappingCase {
  legacy: string
  from: sdk.ProcessingStatus
  to: sdk.ProcessingStatus
}

const legacyMappingCases: LegacyMappingCase[] = [
  // §4 trigger: processAction / isNoSend && !isSendWith → "nosend → nosend"
  // V7: queued (pre-send) → nosend
  { legacy: 'processAction nosend mark', from: 'queued', to: 'nosend' },

  // §4 trigger: processAction delayed broadcast (collapses to queued → queued
  // via `nextActionAt`); covered by identity rule but listed for completeness.
  { legacy: 'processAction delayed (identity)', from: 'queued', to: 'queued' },

  // §4 trigger: processAction pre-broadcast → "queued → broadcasting"
  // V7: queued → sending (sending = "in flight" per ProcessingStatus jsdoc)
  { legacy: 'processAction pre-broadcast', from: 'queued', to: 'sending' },

  // §4 trigger: processAction post-broadcast → "broadcasting → broadcasted"
  // V7: sending → sent (handoff acknowledged)
  { legacy: 'processAction post-broadcast (handoff)', from: 'sending', to: 'sent' },

  // §4 trigger: same post-broadcast path may land at `seen` when the provider
  // ack arrives with a first observation, not just a queue receipt.
  { legacy: 'processAction post-broadcast (seen)', from: 'sending', to: 'seen' },

  // §4 trigger: internalizeAction bump-absent → "unsent → unproven"
  // V7: queued → sent (rawTx exists, handoff implied by bump-absent path)
  { legacy: 'internalizeAction bump-absent', from: 'queued', to: 'sent' },

  // §4 trigger: attemptToPostReqsToNetwork / `invalid` → "* → invalid"
  // V7: each non-terminal state that may host a tx during the attempt loop.
  { legacy: 'attemptToPost invalid (from queued)', from: 'queued', to: 'invalid' },
  { legacy: 'attemptToPost invalid (from sending)', from: 'sending', to: 'invalid' },
  { legacy: 'attemptToPost invalid (from sent)', from: 'sent', to: 'invalid' },
  { legacy: 'attemptToPost invalid (from seen)', from: 'seen', to: 'invalid' },
  { legacy: 'attemptToPost invalid (from seen_multi)', from: 'seen_multi', to: 'invalid' },
  { legacy: 'attemptToPost invalid (from unconfirmed)', from: 'unconfirmed', to: 'invalid' },
  { legacy: 'attemptToPost invalid (from reorging)', from: 'reorging', to: 'invalid' },
  { legacy: 'attemptToPost invalid (from nosend)', from: 'nosend', to: 'invalid' },
  { legacy: 'attemptToPost invalid (from nonfinal)', from: 'nonfinal', to: 'invalid' },

  // §4 trigger: attemptToPost success → "broadcasting → broadcasted" with
  // wasBroadcast=true. V7: sending → sent. Also covers queued → sent on the
  // bump-absent path executed inside the attempt loop.
  { legacy: 'attemptToPost success (queued)', from: 'queued', to: 'sent' },
  { legacy: 'attemptToPost success (sending)', from: 'sending', to: 'sent' },

  // §4 trigger: attemptToPost doubleSpend → "* → doubleSpend" (terminal).
  // V7: every non-terminal state that may host a tx when a doubleSpend
  // notification arrives.
  { legacy: 'attemptToPost doubleSpend (from queued)', from: 'queued', to: 'doubleSpend' },
  { legacy: 'attemptToPost doubleSpend (from sending)', from: 'sending', to: 'doubleSpend' },
  { legacy: 'attemptToPost doubleSpend (from sent)', from: 'sent', to: 'doubleSpend' },
  { legacy: 'attemptToPost doubleSpend (from seen)', from: 'seen', to: 'doubleSpend' },
  { legacy: 'attemptToPost doubleSpend (from seen_multi)', from: 'seen_multi', to: 'doubleSpend' },
  { legacy: 'attemptToPost doubleSpend (from unconfirmed)', from: 'unconfirmed', to: 'doubleSpend' },
  { legacy: 'attemptToPost doubleSpend (from reorging)', from: 'reorging', to: 'doubleSpend' },
  { legacy: 'attemptToPost doubleSpend (from nosend)', from: 'nosend', to: 'doubleSpend' },
  { legacy: 'attemptToPost doubleSpend (from nonfinal)', from: 'nonfinal', to: 'doubleSpend' },

  // §4 trigger: attemptToPost serviceError → "* → sending + attempts++".
  // V7: retry path from any state where a live re-broadcast makes sense.
  // Excludes terminal states (invalid/doubleSpend/proven enter via unfail or
  // reorging, not directly) and excludes `frozen` (operator-paused).
  { legacy: 'attemptToPost serviceError retry (from queued)', from: 'queued', to: 'sending' },
  { legacy: 'attemptToPost serviceError retry (self-retry)', from: 'sending', to: 'sending' },
  { legacy: 'attemptToPost serviceError retry (from sent)', from: 'sent', to: 'sending' },
  { legacy: 'attemptToPost serviceError retry (from seen)', from: 'seen', to: 'sending' },
  { legacy: 'attemptToPost serviceError retry (from seen_multi)', from: 'seen_multi', to: 'sending' },
  { legacy: 'attemptToPost serviceError retry (from unconfirmed)', from: 'unconfirmed', to: 'sending' },
  { legacy: 'attemptToPost serviceError retry (from nosend)', from: 'nosend', to: 'sending' },
  { legacy: 'attemptToPost serviceError retry (from nonfinal)', from: 'nonfinal', to: 'sending' },

  // §4 trigger: Monitor proof → "* → proven". V7: only states that have
  // observed the tx on-chain may transition to proven directly (terminal
  // proof). Pre-observation states must pass through `seen`/`unconfirmed`
  // first — enforced by the FSM, not asserted here.
  { legacy: 'Monitor proof (from seen)', from: 'seen', to: 'proven' },
  { legacy: 'Monitor proof (from seen_multi)', from: 'seen_multi', to: 'proven' },
  { legacy: 'Monitor proof (from unconfirmed)', from: 'unconfirmed', to: 'proven' },
  { legacy: 'Monitor proof (from reorging)', from: 'reorging', to: 'proven' }
]

describe('v7Fsm legacy mapping coverage (V7_STORAGE_METHOD_WIRING §4)', () => {
  it.each(legacyMappingCases)(
    '$legacy: $from -> $to is permitted',
    ({ from, to }: LegacyMappingCase) => {
      expect(isValidProcessingTransition(from, to)).toBe(true)
    }
  )
})
