'use strict'
// Work-order and exported observation DATA only. This module never starts a VM,
// registers a task, invokes PowerShell or grants runtime/host authority.
const path = require('node:path')
const fs = require('node:fs/promises')
const { constants } = require('node:fs')
const { NativeSourceCleanupError } = require('../src/storage/portable/native/prepare_source.cjs')
const limits = Object.freeze({
  memoryBytes: 17179869184,
  CPUCount: 4,
  deadlineMilliseconds: 1200000,
  drainMilliseconds: 30000
})
const guid = value =>
  typeof value === 'string' &&
  /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value) &&
  value !== '00000000-0000-0000-0000-000000000000'
function coordinate(value) {
  if (
    typeof value !== 'string' ||
    value.length > 2048 ||
    !/^[A-Za-z]:\\/.test(value) ||
    /["<>|?*]/.test(value) ||
    Array.from(value).some(c => c.codePointAt(0) < 32) ||
    path.win32.normalize(value) !== value ||
    value
      .slice(3)
      .split('\\')
      .some(p => !p || /[. ]$/.test(p) || p.includes(':') || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(p))
  )
    throw new Error('Windows host work-order coordinate differs')
  return value
}
function pin(input, filename) {
  if (
    !input ||
    !Number.isSafeInteger(input.bytes) ||
    input.bytes < 1 ||
    input.bytes > 1048576 ||
    !/^[a-f0-9]{64}$/.test(input.sha256)
  )
    throw new Error('Windows host work-order source input differs')
  return Object.freeze({
    ...(filename ? { filename: coordinate(input.filename) } : {}),
    bytes: input.bytes,
    sha256: input.sha256
  })
}
function bootstrapHostPlan(configuration) {
  const fields = [
    'protocol',
    'runId',
    'vmId',
    'architecture',
    'guestActorSid',
    'hostController',
    'guestController',
    'guestConfiguration'
  ]
  if (
    !configuration ||
    Object.keys(configuration).length !== fields.length ||
    fields.some(p => !Object.hasOwn(configuration, p)) ||
    configuration.protocol !== 'brc38-windows-bootstrap-host-work-order/v1' ||
    !guid(configuration.runId) ||
    !guid(configuration.vmId) ||
    !['arm64', 'x64'].includes(configuration.architecture) ||
    typeof configuration.guestActorSid !== 'string' ||
    !/^S-1-5-21(?:-[1-9][0-9]{0,9}){4}$/.test(configuration.guestActorSid) ||
    configuration.guestActorSid
      .split('-')
      .slice(4)
      .some(x => Number(x) > 4294967295)
  )
    throw new Error('Windows host work-order target or role differs')
  const controller = pin(configuration.guestController, true),
    options = pin(configuration.guestConfiguration, true)
  if (
    path.win32.basename(controller.filename) !== 'Brc38WindowsBootstrapController.ps1' ||
    controller.filename === options.filename
  )
    throw new Error('Windows host work-order controller coordinate differs')
  return Object.freeze({
    protocol: configuration.protocol,
    runId: configuration.runId,
    vmId: configuration.vmId,
    architecture: configuration.architecture,
    guestActorSid: configuration.guestActorSid,
    vmName: 'ts569-native-windows-bootstrap-' + configuration.runId,
    ownershipMarker: 'brc38-bootstrap/' + configuration.runId,
    watchdogTaskName: 'ts569-bootstrap-stop-' + configuration.runId,
    hostController: pin(configuration.hostController, false),
    guestController: controller,
    guestConfiguration: options,
    limits,
    hostAdmitted: false,
    qualified: false,
    runtimePinChanged: false
  })
}
/** Bounded local source DATA capture. Failed physical closure retains the same
 * original descriptor for concrete retry, never a replacement file. */
async function readBootstrapHostConfiguration(filename) {
  const file = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW)
  let value,
    failure,
    failed = false
  try {
    const before = await file.stat({ bigint: true })
    if (!before.isFile() || before.nlink !== 1n || before.size < 1n || before.size > 1048576n)
      throw new Error('Windows host configuration extent differs')
    const bytes = Buffer.alloc(Number(before.size))
    for (let offset = 0; offset < bytes.length;) {
      const part = await file.read(bytes, offset, Math.min(65536, bytes.length - offset), offset)
      if (!part.bytesRead) throw new Error('Windows host configuration truncated')
      offset += part.bytesRead
    }
    const after = await file.stat({ bigint: true })
    if (
      (await file.read(Buffer.alloc(1), 0, 1, bytes.length)).bytesRead !== 0 ||
      ['dev', 'ino', 'size', 'mode', 'nlink', 'mtimeNs', 'ctimeNs'].some(k => before[k] !== after[k])
    )
      throw new Error('Windows host configuration changed during capture')
    value = bootstrapHostPlan(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)))
  } catch (cause) {
    failed = true
    failure = cause
  }
  try {
    await file.close()
  } catch (cause) {
    throw new NativeSourceCleanupError(failed ? [failure, cause] : [cause], () => file.close())
  }
  if (failed) throw failure
  return value
}
module.exports = Object.freeze({ limits, bootstrapHostPlan, readBootstrapHostConfiguration })
