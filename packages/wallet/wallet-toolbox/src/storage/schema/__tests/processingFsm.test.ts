import * as sdk from '../../../sdk'
import {
  isProcessingSpendable,
  isProcessingTerminal,
  isValidProcessingTransition,
  processingTransitionMap,
  validateProcessingTransition
} from '../processingFsm'

describe('Processing FSM', () => {
  test('identity transitions are allowed', () => {
    const map = processingTransitionMap()
    for (const s of Object.keys(map) as sdk.ProcessingStatus[]) {
      expect(isValidProcessingTransition(s, s)).toBe(true)
    }
  })

  test('queued cannot jump straight to proven', () => {
    expect(isValidProcessingTransition('queued', 'proven')).toBe(false)
    const r = validateProcessingTransition('queued', 'proven')
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/illegal transition/)
  })

  test('canonical happy path: queued -> sending -> sent -> seen -> proven', () => {
    expect(isValidProcessingTransition('queued', 'sending')).toBe(true)
    expect(isValidProcessingTransition('sending', 'sent')).toBe(true)
    expect(isValidProcessingTransition('sent', 'seen')).toBe(true)
    expect(isValidProcessingTransition('seen', 'proven')).toBe(true)
  })

  test('terminal states block direct re-entry except via unfail', () => {
    expect(isValidProcessingTransition('invalid', 'queued')).toBe(false)
    expect(isValidProcessingTransition('invalid', 'unfail')).toBe(true)
    expect(isValidProcessingTransition('doubleSpend', 'unfail')).toBe(true)
    expect(isValidProcessingTransition('proven', 'reorging')).toBe(true)
  })

  test('isProcessingSpendable matches sdk constant', () => {
    expect(isProcessingSpendable('sent')).toBe(true)
    expect(isProcessingSpendable('proven')).toBe(true)
    expect(isProcessingSpendable('queued')).toBe(false)
    expect(isProcessingSpendable('invalid')).toBe(false)
  })

  test('isProcessingTerminal matches sdk constant', () => {
    expect(isProcessingTerminal('proven')).toBe(true)
    expect(isProcessingTerminal('invalid')).toBe(true)
    expect(isProcessingTerminal('doubleSpend')).toBe(true)
    expect(isProcessingTerminal('queued')).toBe(false)
  })
})
