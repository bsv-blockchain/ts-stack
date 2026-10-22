import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import {
  browserSandboxProfile,
  browserSandboxParserInvocation
} from './wallet-native-browser-sandbox.mjs'

test('sandbox attachment grants user namespaces to one literal delivered path and retains the global policy', () => {
  const executable = '/tmp/ts-wallet-native-browser-original/chrome-linux-arm64/chrome'
  const profile = browserSandboxProfile(executable)
  assert.match(profile.name, /^ts_stack_wallet_browser_[a-f0-9]{64}$/)
  assert.equal(profile.sha256, createHash('sha256').update(profile.text).digest('hex'))
  assert.ok(profile.text.includes(`"${executable}" flags=(unconfined)`))
  assert.equal(profile.text.match(/userns,/g).length, 1)
  assert.equal(profile.text.includes('*'), false)
  for (const forbidden of ['sysctl', 'no-sandbox', 'setuid', '/proc/sys/', 'capability', 'mount,'])
    assert.equal(profile.text.includes(forbidden), false)
  assert.notEqual(profile.name, browserSandboxProfile('/tmp/other/chrome').name)
  assert.ok(Object.isFrozen(profile))
})
test('privileged parser receives only validated generated profile data through stdin', () => {
  const executable = '/tmp/one literal path/chrome'
  for (const [action, flag] of [
    ['install', '--replace'],
    ['remove', '--remove']
  ]) {
    const invocation = browserSandboxParserInvocation(executable, action)
    assert.equal(invocation.program, '/usr/bin/sudo')
    assert.deepEqual(invocation.args, ['-n', '/usr/sbin/apparmor_parser', flag, '--skip-cache'])
    assert.equal(invocation.input, browserSandboxProfile(executable).text)
    assert.ok(Object.isFrozen(invocation.args))
  }
  assert.throws(() => browserSandboxParserInvocation(executable, 'reload-all'))
})
test('relative, noncanonical, glob, variable, quote and control-character attachments refuse before privilege', () => {
  for (const path of [
    'chrome',
    '/tmp/../chrome',
    '/tmp/*/chrome',
    '/tmp/?/chrome',
    '/tmp/[a]/chrome',
    '/tmp/{a,b}/chrome',
    '/tmp/@{HOME}/chrome',
    '/tmp/"/chrome',
    '/tmp/\\/chrome',
    '/tmp/\n/chrome',
    '/tmp/\0/chrome',
    '/tmp/\t/chrome',
    '/tmp/other',
    '/tmp//chrome'
  ])
    assert.throws(() => browserSandboxProfile(path), path)
})
