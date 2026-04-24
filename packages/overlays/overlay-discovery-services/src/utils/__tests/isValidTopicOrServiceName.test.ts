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

    // Only lower-case letters and underscores allowed (no digits or special characters)
    it('should invalidate names containing non-alphabetic characters', () => {
        expect(isValidTopicOrServiceName('tm_uhrp_files2')).toBe(false)
        expect(isValidTopicOrServiceName('ls_tempo_songs-search')).toBe(false)
        expect(isValidTopicOrServiceName('tm_uhrp%files')).toBe(false)
    })

    // Length checks: Must not exceed 50 characters
    it('should invalidate names exceeding 50 characters', () => {
        // "tm_" is 3 characters, so append 48 letters to make a 51-character string.
        const longName = 'tm_' + 'a'.repeat(48)
        expect(longName.length).toBe(51)
        expect(isValidTopicOrServiceName(longName)).toBe(false)
    })

    it('should validate a name with exactly 50 characters', () => {
        // "tm_" is 3 characters, so append 47 letters to make a 50-character string.
        const validName = 'tm_' + 'a'.repeat(47)
        expect(validName.length).toBe(50)
        expect(isValidTopicOrServiceName(validName)).toBe(true)
    })

    // Empty string should be invalid
    it('should invalidate an empty string', () => {
        expect(isValidTopicOrServiceName('')).toBe(false)
    })
})
