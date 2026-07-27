import { runArgv2Function } from '../src/runArgv2Function'

describe('runArgv2Function', () => {
  const originalArgv = [...process.argv]

  afterEach(() => {
    process.argv = [...originalArgv]
    jest.restoreAllMocks()
  })

  test('runs the explicitly named async example', async () => {
    const named = jest.fn(async () => {})
    process.argv = ['node', '/tmp/example.ts', 'named']

    await runArgv2Function({ named })

    expect(named).toHaveBeenCalledTimes(1)
  })

  test('falls back to the script basename', async () => {
    const backup = jest.fn(async () => {})
    process.argv = ['node', '/tmp/backup.ts']

    await runArgv2Function({ backup })

    expect(backup).toHaveBeenCalledTimes(1)
  })

  test('does not execute a non-function export', () => {
    process.argv = ['node', '/tmp/example.ts', 'value']

    expect(runArgv2Function({ value: 42 })).toBeUndefined()
  })

  test('does not execute when no export matches', () => {
    process.argv = ['node', '/tmp/missing.ts']

    expect(runArgv2Function({ other: async () => {} })).toBeUndefined()
  })

  test('reports synchronous and asynchronous example failures', async () => {
    const syncFailure = new Error('sync failure')
    const asyncFailure = new Error('async failure')
    const error = jest.spyOn(console, 'error').mockImplementation(() => {})

    process.argv = ['node', '/tmp/example.ts', 'sync']
    await runArgv2Function({
      sync: () => {
        throw syncFailure
      }
    })

    process.argv = ['node', '/tmp/example.ts', 'async']
    await runArgv2Function({
      async: async () => {
        throw asyncFailure
      }
    })

    expect(error).toHaveBeenNthCalledWith(1, syncFailure)
    expect(error).toHaveBeenNthCalledWith(2, asyncFailure)
  })
})
