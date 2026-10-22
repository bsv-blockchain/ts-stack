import {
  isOverlayLookupServiceName,
  isOverlayTopicName,
  MAX_OVERLAY_NAME_BYTES,
  OVERLAY_LOOKUP_SERVICE_NAME_PATTERN,
  OVERLAY_TOPIC_NAME_PATTERN
} from '../OverlayNames'
import * as overlayTools from '../index'

const assetId = `${'0123456789abcdef'.repeat(4)}_0`

describe('overlay topic and lookup service names', () => {
  it('is exported from the overlay tools entry point', () => {
    expect(overlayTools.isOverlayTopicName).toBe(isOverlayTopicName)
    expect(overlayTools.isOverlayLookupServiceName).toBe(isOverlayLookupServiceName)
    expect(overlayTools.MAX_OVERLAY_NAME_BYTES).toBe(256)
    expect(MAX_OVERLAY_NAME_BYTES).toBe(256)
  })

  it.each([
    'tm_uhrp_files',
    'tm_a',
    'tm_2',
    `tm_color_${assetId}`,
    `tm_color_${'ff'.repeat(32)}_4294967295`,
    'tm_' + 'a'.repeat(253)
  ])('accepts topic name %s', name => {
    expect(isOverlayTopicName(name)).toBe(true)
    expect(OVERLAY_TOPIC_NAME_PATTERN.test(name)).toBe(true)
    expect(isOverlayLookupServiceName(name)).toBe(false)
  })

  it.each(['ls_uhrp_files', 'ls_a', `ls_color_${assetId}`, 'ls_' + 'a'.repeat(253)])(
    'accepts lookup service name %s',
    name => {
      expect(isOverlayLookupServiceName(name)).toBe(true)
      expect(OVERLAY_LOOKUP_SERVICE_NAME_PATTERN.test(name)).toBe(true)
      expect(isOverlayTopicName(name)).toBe(false)
    }
  )

  it.each([
    ['tm_', 'ls_'],
    ['tm__x', 'ls__x'],
    ['tm_x_', 'ls_x_'],
    ['tm_x__y', 'ls_x__y'],
    ['tm_Color', 'ls_Color'],
    [`tm_color_${assetId.toUpperCase()}`, `ls_color_${assetId.toUpperCase()}`],
    ['tm_' + 'a'.repeat(254), 'ls_' + 'a'.repeat(254)],
    ['tm_' + 'a'.repeat(297), 'ls_' + 'a'.repeat(297)],
    [`color_${assetId}`, `color_${assetId}`],
    ['tm-x', 'ls-x'],
    ['tm_x-y', 'ls_x-y'],
    ['tm_x\n', 'ls_x\n'],
    ['tm_é', 'ls_é'],
    ['', '']
  ])('rejects %s and %s', (topic, service) => {
    expect(isOverlayTopicName(topic)).toBe(false)
    expect(isOverlayLookupServiceName(service)).toBe(false)
  })

  it('rejects non-string values', () => {
    expect(isOverlayTopicName(undefined)).toBe(false)
    expect(isOverlayTopicName(['tm_a'])).toBe(false)
    expect(isOverlayLookupServiceName(7)).toBe(false)
  })
})
