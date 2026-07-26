import assert from 'node:assert/strict'
import { execPath } from 'node:process'
import test from 'node:test'

import { createCommandRunner } from './lib/command-runner.mjs'

test('command runner returns encoded output and accepts execution options', async () => {
  const run = createCommandRunner({
    timeoutMs: 1_000,
    maxBufferBytes: 1_024
  })

  const { stdout } = await run(
    execPath,
    ['-e', 'process.stdout.write(process.env.COMMAND_RUNNER_VALUE)'],
    {
      env: {
        COMMAND_RUNNER_VALUE: 'verified'
      }
    }
  )

  assert.equal(stdout, 'verified')
})

test('command runner reports bounded stdout and stderr when a command fails', async () => {
  const run = createCommandRunner({
    timeoutMs: 1_000,
    maxBufferBytes: 1_024,
    maxErrorOutputCharacters: 12
  })

  await assert.rejects(
    run(execPath, [
      '-e',
      [
        "process.stdout.write('abcdefghijklmnop')",
        "process.stderr.write('qrstuvwxyz012345')",
        'process.exitCode = 7'
      ].join(';')
    ]),
    error => {
      assert.match(error.message, /node .* failed:/)
      const details = error.message.split(' failed:\n')[1]
      assert.match(details, /4 characters omitted/)
      assert.doesNotMatch(details, /abcdefghijklmnop/)
      assert.doesNotMatch(details, /qrstuvwxyz012345/)
      return true
    }
  )
})
