import { afterEach, expect, jest, test } from '@jest/globals'

// The bin entry point: hands process.argv and the interactive prompt to start().

const start = jest.fn((_argv: string[], _provider?: unknown) => undefined)
const interactiveConfigPrompt = jest.fn()
jest.mock('../cli', () => ({ start }))
jest.mock('../prompts', () => ({ interactiveConfigPrompt }))

const savedArgv = process.argv
afterEach(() => {
  process.argv = savedArgv
})

test('starts the CLI with its arguments and the interactive prompt', async () => {
  process.argv = ['node', 'create-bsv-app', 'new', 'my-app', '--yes']
  await jest.isolateModulesAsync(async () => {
    await import('../index')
  })
  expect(start).toHaveBeenCalledWith(['new', 'my-app', '--yes'], interactiveConfigPrompt)
})
