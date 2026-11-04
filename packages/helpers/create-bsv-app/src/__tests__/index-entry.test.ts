import { afterEach, expect, jest, test } from '@jest/globals'

// The bin entry point: hands process.argv and the interactive prompt to main() and sets the exit code.

const main = jest.fn(async (_argv: string[], _provider?: unknown) => 3)
const interactiveConfigPrompt = jest.fn()
jest.mock('../cli', () => ({ main }))
jest.mock('../prompts', () => ({ interactiveConfigPrompt }))

const savedArgv = process.argv
afterEach(() => {
  process.argv = savedArgv
  process.exitCode = undefined
})

test('runs main with the CLI arguments and the interactive prompt, then sets the exit code', async () => {
  process.argv = ['node', 'create-bsv-app', 'new', 'my-app', '--yes']
  await jest.isolateModulesAsync(async () => {
    await import('../index')
  })
  await new Promise(resolve => setImmediate(resolve))
  expect(main).toHaveBeenCalledWith(['new', 'my-app', '--yes'], interactiveConfigPrompt)
  expect(process.exitCode).toBe(3)
})
