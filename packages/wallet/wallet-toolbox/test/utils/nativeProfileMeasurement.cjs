'use strict'
const assert = require('node:assert/strict')
const cp = require('node:child_process')
const { performance } = require('node:perf_hooks')
let active = false

/** Qualification-only observation of original native child pipes. It delegates
 * to the actual spawn/write functions and copies at most sixteen reply-header
 * bytes. It never exposes SQL, bindings, paths, records or archive bytes. These
 * counters do not authenticate a profile or prove process-tree/resource exit.
 * The real driver must still validate every reply and physical child lifecycle.
 * SQL BEGIN IMMEDIATE/EXCLUSIVE -> commit/rollback replies give conservative
 * writer-lock enclosures, not an exact in-kernel lock timer. UNRUN. */
function observeNativeProfileMeasurement() {
  assert.equal(active, false, 'Only one finite native measurement observer per module')
  active = true
  const spawn = cp.spawn,
    children = new Set(),
    maximumChildren = 64,
    maximumSamples = 32768,
    cancellation = new AbortController()
  let fault,
    closed = false,
    phase = empty()
  function empty() {
    return {
      nativeRequests: 0,
      nativeSqlQueries: 0,
      requestWireBytes: 0,
      responseWireBytes: 0,
      successfulReplies: 0,
      failedReplies: 0,
      writerEnclosureLowerMs: [],
      writerEnclosureUpperMs: []
    }
  }
  function fail(cause) {
    if (fault !== undefined) return
    fault = cause
    cancellation.abort(cause)
  }
  function add(key, count) {
    const value = phase[key] + count
    if (!Number.isSafeInteger(value) || value < 0) {
      fail(new Error('Native measurement counter bound reached'))
      return
    }
    phase[key] = value
  }
  cp.spawn = function (...args) {
    const child = Reflect.apply(spawn, this, args)
    if (children.size >= maximumChildren) {
      fail(new Error('Native measurement child ceiling reached'))
      return child
    }
    if (child.stdin === null || child.stdout === null) return child
    const input = child.stdin,
      output = child.stdout,
      write = input.write,
      pending = new Map(),
      writers = new Map(),
      header = Buffer.alloc(4),
      prefix = Buffer.alloc(12)
    let headerAt = 0,
      prefixAt = 0,
      remaining = 0,
      enrolled = false
    const owner = { child, input, write, pending, writers, data: undefined }
    children.add(owner)
    input.write = function (...selected) {
      if (fault !== undefined) return Reflect.apply(write, this, selected)
      const packet = selected[0]
      if (
        Buffer.isBuffer(packet) &&
        packet.length >= 12 &&
        packet.readUInt32LE(0) === packet.length - 4 &&
        packet[8] <= 11 &&
        packet[9] <= 3 &&
        packet[11] === 0
      ) {
        enrolled = true
        if (pending.size >= 1) fail(new Error('Native measurement observed overlapping original requests'))
        const operation = packet[8],
          slot = packet[9],
          id = packet.readUInt32LE(4),
          began = performance.now()
        // Only a bounded original SQL prefix is examined; its text is neither
        // stored nor emitted. Actual writer slots are separately reported.
        const sqlLength = operation === 0 && packet.length >= 20 ? packet.readUInt32LE(12) : 0
        const immediate =
          operation === 0 &&
          slot === 0 &&
          sqlLength > 0 &&
          sqlLength <= packet.length - 20 &&
          /^BEGIN\s+(?:TRANSACTION\s+)?(?:IMMEDIATE|EXCLUSIVE)\b/i.test(
            packet.toString('ascii', 20, 20 + Math.min(sqlLength, 40))
          )
        pending.set(id, { operation, slot, began, immediate })
        add('nativeRequests', 1)
        add('requestWireBytes', packet.length)
        if (operation === 0) add('nativeSqlQueries', 1)
      }
      return Reflect.apply(write, this, selected)
    }
    owner.observedWrite = input.write
    owner.data = function (bytes) {
      if (fault !== undefined || !enrolled || !Buffer.isBuffer(bytes)) return
      add('responseWireBytes', bytes.length)
      try {
        let at = 0
        while (at < bytes.length) {
          if (remaining === 0) {
            const count = Math.min(4 - headerAt, bytes.length - at)
            bytes.copy(header, headerAt, at, at + count)
            headerAt += count
            at += count
            if (headerAt !== 4) continue
            remaining = header.readUInt32LE(0)
            headerAt = 0
            prefixAt = 0
            assert.ok(remaining >= 12 && remaining <= 16777216, 'Native observation frame bound differs')
          }
          const count = Math.min(remaining, bytes.length - at),
            copied = Math.min(count, 12 - prefixAt)
          if (copied > 0) {
            bytes.copy(prefix, prefixAt, at, at + copied)
            prefixAt += copied
          }
          remaining -= count
          at += count
          if (remaining !== 0) continue
          const id = prefix.readUInt32LE(0),
            rc = prefix.readUInt32LE(4),
            request = pending.get(id),
            ended = performance.now()
          assert.ok(request, 'Observed native reply has no original sent request')
          assert.ok(prefix[9] === 0 || prefix[9] === 1, 'Observed native autocommit flag differs')
          pending.delete(id)
          add(rc === 0 ? 'successfulReplies' : 'failedReplies', 1)
          if (rc === 0 && request.immediate && prefix[9] === 0)
            writers.set(request.slot, { sent: request.began, acknowledged: ended })
          const writer = writers.get(request.slot)
          if (writer !== undefined && prefix[9] === 1) {
            if (phase.writerEnclosureLowerMs.length >= maximumSamples)
              fail(new Error('Native transaction sample ceiling reached'))
            else {
              // Lock acquisition happened before BEGIN ACK; release happened
              // after the terminating request and before its final ACK.
              phase.writerEnclosureLowerMs.push(Math.max(0, request.began - writer.acknowledged))
              phase.writerEnclosureUpperMs.push(Math.max(0, ended - writer.sent))
            }
            writers.delete(request.slot)
          }
        }
      } catch (cause) {
        fail(cause)
      }
    }
    output.on('data', owner.data)
    return child
  }
  const replacement = cp.spawn
  return Object.freeze({
    signal: cancellation.signal,
    beginPhase() {
      assert.equal(closed, false)
      if (fault !== undefined) throw fault
      for (const owner of children) assert.equal(owner.pending.size, 0, 'Previous native request did not settle')
      phase = empty()
    },
    report() {
      assert.equal(closed, false)
      if (fault !== undefined) throw fault
      for (const owner of children) {
        assert.equal(owner.pending.size, 0, 'Native measurement reply did not drain')
        assert.equal(owner.writers.size, 0, 'Original observed native writer remained open at phase completion')
      }
      assert.equal(
        phase.nativeRequests,
        phase.successfulReplies + phase.failedReplies,
        'Actual native request/reply count differs'
      )
      return {
        ...phase,
        writerEnclosureLowerMs: [...phase.writerEnclosureLowerMs],
        writerEnclosureUpperMs: [...phase.writerEnclosureUpperMs],
        scope: 'actual native pipe requests/replies; BEGIN IMMEDIATE/EXCLUSIVE on slot0 only',
        exactKernelLockDuration: false,
        processTreeQualified: false
      }
    },
    close() {
      if (closed) return
      assert.equal(cp.spawn, replacement, 'Native measurement spawn owner was replaced')
      cp.spawn = spawn
      const failures = []
      for (const owner of children) {
        owner.child.stdout.removeListener('data', owner.data)
        if (owner.input.write !== owner.observedWrite)
          failures.push(new Error('Native measurement write owner was replaced'))
        else owner.input.write = owner.write
      }
      closed = true
      active = false
      if (fault !== undefined) failures.push(fault)
      if (failures.length !== 0)
        throw new AggregateError(failures, 'Native measurement retains original observer faults')
    }
  })
}
module.exports = { observeNativeProfileMeasurement }
