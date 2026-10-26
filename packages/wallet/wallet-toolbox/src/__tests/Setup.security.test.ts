import { Setup } from '../Setup'

describe('Setup secret-output boundary', () => {
  test('returns generated development credentials without copying them to the process console', () => {
    const consoleLog = jest.spyOn(console, 'log').mockImplementation(() => {})

    const env = Setup.makeEnv()

    expect(env).toContain('DEV_KEYS')
    expect(env).toContain('MY_TEST_IDENTITY')
    expect(consoleLog).not.toHaveBeenCalled()
    consoleLog.mockRestore()
  })
})
