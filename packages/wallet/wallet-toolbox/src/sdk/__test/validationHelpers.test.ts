import { Utils, Validation as V } from '@bsv/sdk'
describe('validationHelpers tests', () => {
  jest.setTimeout(99999999)

  test('0 validateBase64String', async () => {
    const validB64 = 'SGVsbG8gV29ybGQh' // "Hello World!"

    const s = V.validateBase64String(validB64, 'testParam', 1, 20)
    expect(s).toBe(validB64)

    {
      const invalidB64 = 'SGVsbG8g29ybGQh'
      expect(() => V.validateBase64String(invalidB64, 'testParam', 1, 20)).toThrow()
    }

    {
      const invalidB64 = 'SGVsbG8gV29ybGQh='
      expect(() => V.validateBase64String(invalidB64, 'testParam', 1, 20)).toThrow()
    }
  })
})
