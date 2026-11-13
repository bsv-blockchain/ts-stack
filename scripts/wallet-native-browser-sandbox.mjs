import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isAbsolute, resolve, basename } from 'node:path'

const restrictionFile = '/proc/sys/kernel/apparmor_restrict_unprivileged_userns'
const profilesFile = '/sys/kernel/security/apparmor/profiles'
export function browserSandboxProfile(executable) {
  assert.equal(typeof executable, 'string')
  assert.ok(executable.length > 0 && executable.length <= 4096)
  assert.ok(isAbsolute(executable) && resolve(executable) === executable)
  assert.equal(basename(executable), 'chrome')
  // AppArmor interprets glob/variable syntax even inside quoted attachments.
  // CI delivery paths need no expansion or control characters.
  assert.match(executable, /^\/[A-Za-z0-9_./ -]+$/)
  const name = 'ts_stack_wallet_browser_' + createHash('sha256').update(executable).digest('hex')
  const text = `abi <abi/4.0>,\ninclude <tunables/global>\nprofile ${name} "${executable}" flags=(unconfined) {\n  userns,\n}\n`
  return Object.freeze({ name, text, sha256: createHash('sha256').update(text).digest('hex') })
}
export function browserSandboxParserInvocation(executable, action) {
  assert.ok(action === 'install' || action === 'remove')
  const profile = browserSandboxProfile(executable)
  return Object.freeze({
    program: '/usr/bin/sudo',
    args: Object.freeze([
      '-n',
      '/usr/sbin/apparmor_parser',
      action === 'install' ? '--replace' : '--remove',
      '--skip-cache'
    ]),
    input: profile.text
  })
}
function execute(program, args, input) {
  const result = spawnSync(program, args, {
    input,
    encoding: 'utf8',
    timeout: 10000,
    maxBuffer: 1048576,
    killSignal: 'SIGTERM'
  })
  if (result.error || result.status !== 0 || result.signal !== null)
    throw new Error('Pinned browser sandbox configuration or observation failed', {
      cause: result.error
    })
  return result.stdout
}
function profiles() {
  return execute('/usr/bin/sudo', ['-n', '/bin/cat', profilesFile]).split('\n')
}
function installed(lines, name) {
  return lines.some(line => line.startsWith(name + ' ('))
}
function update(executable, action) {
  const command = browserSandboxParserInvocation(executable, action)
  execute(command.program, command.args, command.input)
}
export async function installNativeBrowserSandbox(executable) {
  assert.equal(process.platform, 'linux')
  const profile = browserSandboxProfile(executable)
  let restriction
  try {
    restriction = (await readFile(restrictionFile, 'utf8')).trim()
  } catch (cause) {
    if (cause.code !== 'ENOENT') throw cause
    restriction = null
  }
  assert.ok(restriction === null || ['0', '1', '2'].includes(restriction))
  if (restriction === null || restriction === '0')
    return Object.freeze({ mode: 'not-required', restriction })
  assert.ok(
    !installed(profiles(), profile.name),
    'A previous browser sandbox attachment remains owned'
  )
  try {
    update(executable, 'install')
    assert.ok(profiles().includes(profile.name + ' (unconfined)'))
    assert.equal((await readFile(restrictionFile, 'utf8')).trim(), restriction)
  } catch (cause) {
    try {
      if (installed(profiles(), profile.name)) update(executable, 'remove')
      assert.ok(!installed(profiles(), profile.name))
    } catch (error_) {
      throw new AggregateError(
        [cause, error_],
        'Pinned browser retains its exact sandbox attachment'
      )
    }
    throw cause
  }
  return Object.freeze({
    mode: 'exact-executable',
    restriction,
    profile: profile.name,
    profileSha256: profile.sha256
  })
}
export async function removeNativeBrowserSandbox(executable, receipt) {
  assert.equal(process.platform, 'linux')
  if (receipt.mode === 'not-required') return { removed: false, required: false }
  assert.equal(receipt.mode, 'exact-executable')
  const profile = browserSandboxProfile(executable)
  assert.equal(receipt.profile, profile.name)
  assert.equal(receipt.profileSha256, profile.sha256)
  if (installed(profiles(), profile.name)) update(executable, 'remove')
  assert.ok(!installed(profiles(), profile.name))
  assert.equal((await readFile(restrictionFile, 'utf8')).trim(), receipt.restriction)
  return { removed: true, actualProfileAbsent: true, globalRestrictionUnchanged: true }
}
