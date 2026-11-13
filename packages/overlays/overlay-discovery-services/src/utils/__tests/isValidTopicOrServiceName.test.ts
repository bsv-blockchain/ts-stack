import { isValidTopicOrServiceName } from '../isValidTopicOrServiceName'

describe('isValidTopicOrServiceName', () => {
  // Valid BRC-22 Topic Manager names
  it('should validate valid BRC-22 Topic Manager names', () => {
    expect(isValidTopicOrServiceName('tm_uhrp_files')).toBe(true)
    expect(isValidTopicOrServiceName('tm_tempo_songs')).toBe(true)
    expect(isValidTopicOrServiceName('tm_a')).toBe(true)
    expect(isValidTopicOrServiceName('tm_a_b_c')).toBe(true)
  })

  // Valid BRC-24 Lookup Service names
  it('should validate valid BRC-24 Lookup Service names', () => {
    expect(isValidTopicOrServiceName('ls_uhrp_files')).toBe(true)
    expect(isValidTopicOrServiceName('ls_tempo_songs_search')).toBe(true)
    expect(isValidTopicOrServiceName('ls_a')).toBe(true)
    expect(isValidTopicOrServiceName('ls_a_b')).toBe(true)
  })

  // Incorrect prefix cases
  it('should invalidate names with incorrect prefixes', () => {
    expect(isValidTopicOrServiceName('tp_uhrp_files')).toBe(false)
    expect(isValidTopicOrServiceName('um_tempo_songs')).toBe(false)
  })

  // Uppercase letters not allowed
  it('should invalidate names containing uppercase letters', () => {
    expect(isValidTopicOrServiceName('tm_Tempo_songs')).toBe(false)
    expect(isValidTopicOrServiceName('ls_tempo_Songs')).toBe(false)
  })

  // Starting or ending with underscore (outside the prefix) should fail
  it('should invalidate names that start or end with an underscore', () => {
    expect(isValidTopicOrServiceName('_tm_uhrp_files')).toBe(false)
    expect(isValidTopicOrServiceName('tm_uhrp_files_')).toBe(false)
  })

  // Consecutive underscores are not allowed
  it('should invalidate names with consecutive underscores', () => {
    expect(isValidTopicOrServiceName('tm__uhrp_files')).toBe(false)
    expect(isValidTopicOrServiceName('ls_tempo__songs')).toBe(false)
  })

  // BRC-207 per-asset names: lowercase hex txid, underscore, decimal output index
  it('should validate BRC-207 per-asset topic and lookup service names', () => {
    const assetId = `${'0123456789abcdef'.repeat(4)}_0`
    expect(isValidTopicOrServiceName(`tm_color_${assetId}`)).toBe(true)
    expect(isValidTopicOrServiceName(`ls_color_${assetId}`)).toBe(true)
    expect(isValidTopicOrServiceName('tm_uhrp_files2')).toBe(true)
  })

  // Only lower-case letters, digits and underscores allowed
  it('should invalidate names containing other characters', () => {
    expect(isValidTopicOrServiceName('ls_tempo_songs-search')).toBe(false)
    expect(isValidTopicOrServiceName('tm_uhrp%files')).toBe(false)
    expect(isValidTopicOrServiceName('tm_uhrp files')).toBe(false)
    expect(isValidTopicOrServiceName('tm_\u00e9')).toBe(false)
  })

  it('should invalidate a bare prefix and names without a prefix', () => {
    expect(isValidTopicOrServiceName('tm_')).toBe(false)
    expect(isValidTopicOrServiceName('ls_')).toBe(false)
    expect(isValidTopicOrServiceName('tm__x')).toBe(false)
    expect(isValidTopicOrServiceName('tm_x_')).toBe(false)
    expect(isValidTopicOrServiceName('color_abc')).toBe(false)
  })

  // Length checks: at most 256 bytes, the overlay engine's topic limit
  it('should invalidate names exceeding 256 bytes', () => {
    const longName = 'tm_' + 'a'.repeat(254)
    expect(longName).toHaveLength(257)
    expect(isValidTopicOrServiceName(longName)).toBe(false)
    expect(isValidTopicOrServiceName('tm_' + 'a'.repeat(297))).toBe(false)
  })

  it('should validate a name with exactly 256 bytes', () => {
    const validName = 'ls_' + 'a'.repeat(253)
    expect(validName).toHaveLength(256)
    expect(isValidTopicOrServiceName(validName)).toBe(true)
  })

  // Empty string should be invalid
  it('should invalidate an empty string', () => {
    expect(isValidTopicOrServiceName('')).toBe(false)
  })
})
