import assert from 'node:assert/strict'
import test from 'node:test'
import {
  makeTargetReceipt,
  verifyFullCampaign,
  loadCanonicalEvidence
} from './mutation-final-qualification.mjs'

import {
  identity,
  inventory,
  policy,
  evidence,
  report,
  executionFor
} from './ci-integration/fixtures/qualification-fixture.mjs'
const entry = (target, statuses, mode = 'full') => {
  const reportBytes = JSON.stringify(report(statuses))
  const executionBytes = executionFor(reportBytes, target)
  return {
    reportBytes,
    executionBytes,
    receipt: makeTargetReceipt(
      identity,
      target,
      reportBytes,
      policy,
      mode,
      evidence,
      executionBytes
    )
  }
}
const qualify = entries => verifyFullCampaign(identity, entries, policy, () => evidence)
const capture = value =>
  makeTargetReceipt(
    identity,
    'one',
    JSON.stringify(value),
    policy,
    'full',
    evidence,
    executionFor(JSON.stringify(value))
  )

test('complete exact-source campaigns preserve every target score, no-coverage and invalid gate', () => {
  const qualified = qualify([entry('two'), entry('one')])
  assert.equal(qualified.identity.sourceSha, identity.sourceSha)
  assert.equal(qualified.targetCount, 2)
  assert.throws(() => entry('one', ['NoCoverage']), /below|no-coverage/)
  assert.throws(() => entry('one', ['CompileError']), /invalid/)
  assert.throws(() => entry('one', ['Pending']), /Unknown/)
  assert.ok(inventory.length > 5)
})

test('missing, duplicate, extra and diagnostic targets never qualify a full campaign', () => {
  assert.throws(() => qualify([entry('one')]), /every canonical/)
  assert.throws(() => qualify([]), /every canonical/)
  assert.throws(() => qualify([entry('one'), entry('one'), entry('two')]), /Duplicate/)
  assert.throws(() => entry('extra'), /outside canonical/)
  assert.throws(() => qualify([entry('one'), entry('two', undefined, 'diagnostic')]), /Diagnostic/)
})

test('head, attempt, runtime, control inputs and modified receipts fail closed', () => {
  for (const field of [
    'sourceSha',
    'runId',
    'runAttempt',
    'nodeVersion',
    'inputsDigest',
    'targetsDigest'
  ]) {
    const entries = [entry('one'), entry('two')]
    entries[0].receipt.identity = { ...identity, [field]: 'different' }
    assert.throws(() => qualify(entries), /identity/)
  }
  const entries = [entry('one'), entry('two')]
  entries[0].reportBytes += '\n'
  assert.throws(() => qualify(entries), /changed|execution/)
  entries[0] = entry('one')
  entries[0].receipt.metrics.score = 99
  assert.throws(() => qualify(entries), /changed|execution/)
})

test('source bytes, missing mutant-bearing files and missing individual mutants fail closed', () => {
  for (const change of [
    value => {
      value.files['src/api.ts'].source += 'old bytes'
    },
    value => {
      delete value.files['src/other.ts']
    },
    value => {
      value.files['src/api.ts'].mutants.pop()
    }
  ]) {
    const value = report()
    change(value)
    assert.throws(() => capture(value), /source differs|inventory/)
  }
  assert.equal(report().files['src/types.ts'], undefined)
  assert.doesNotThrow(() => capture(report()))
})

test('execution configuration, target ranges, runner, schema and engine are independently bound', () => {
  for (const change of [
    value => {
      value.config.mutate = ['src/api.ts:1-1']
    },
    value => {
      value.config.jest.config.testMatch = ['subset.test.ts']
    },
    value => {
      value.config.concurrency = 1
    },
    value => {
      value.config.incremental = true
    },
    value => {
      value.config.ignoreStatic = true
    },
    value => {
      value.config.mutator.excludedMutations = ['EqualityOperator']
    },
    value => {
      value.framework.version = '9.5.0'
    },
    value => {
      value.schemaVersion = 'unknown'
    },
    value => {
      value.projectRoot += '/other'
    }
  ]) {
    const value = report()
    change(value)
    assert.throws(() => capture(value), /execution differs|schema or engine|project root/)
  }
})

test('IDs, positions, replacements and unsupported ignored mutants cannot fabricate inventory', () => {
  for (const change of [
    mutants => {
      mutants[1].id = mutants[0].id
    },
    mutants => {
      delete mutants[0].id
    },
    mutants => {
      mutants[0].location.start.line = 0
    },
    mutants => {
      mutants[0].mutatorName = ''
    },
    mutants => {
      mutants[0].replacement = 'different'
    },
    mutants => {
      mutants[0].status = 'Ignored'
      mutants[0].statusReason = 'not canonical'
    }
  ]) {
    const value = report()
    change(value.files['src/api.ts'].mutants)
    assert.throws(() => capture(value), /ID|structure|inventory/)
  }
})

test('actual reporter end-before-start field order preserves semantic mutant identity', () => {
  const value = report()
  for (const file of Object.values(value.files))
    for (const mutant of file.mutants) {
      const { start, end } = mutant.location
      mutant.location = { end, start }
    }
  assert.doesNotThrow(() => capture(value))
})

test('successful execution evidence binds the exact report, properties, run and runtime', () => {
  const reportBytes = JSON.stringify(report())
  for (const change of [
    value => {
      value.runAttempt = 'old'
    },
    value => {
      value.targetId = 'other'
    },
    value => {
      value.reportDigest = 'old'
    },
    value => {
      value.propertyEnvironment.FAST_CHECK_NUM_RUNS = '20'
    },
    value => {
      value.propertyEnvironment.FAST_CHECK_SEED = 'other'
    },
    value => {
      value.propertyEnvironment.FAST_CHECK_PATH = 'partial'
    }
  ]) {
    const value = JSON.parse(executionFor(reportBytes))
    change(value)
    assert.throws(
      () =>
        makeTargetReceipt(
          identity,
          'one',
          reportBytes,
          policy,
          'full',
          evidence,
          JSON.stringify(value)
        ),
      /execution|property/
    )
  }
  const replay = JSON.parse(executionFor(reportBytes))
  replay.propertyEnvironment.FAST_CHECK_PATH = 'partial'
  assert.equal(
    makeTargetReceipt(
      identity,
      'one',
      reportBytes,
      policy,
      'diagnostic',
      evidence,
      JSON.stringify(replay)
    ).mode,
    'diagnostic'
  )
})

test('canonical evidence loading bounds resource concurrency and propagates missing evidence', async () => {
  const ids = Array.from({ length: 33 }, (_, index) => String(index))
  let active = 0
  let peak = 0
  const results = await loadCanonicalEvidence(ids, async id => {
    active += 1
    peak = Math.max(peak, active)
    await new Promise(resolve => setImmediate(resolve))
    active -= 1
    return `canonical-${id}`
  })
  assert.equal(peak, 4)
  assert.equal(results.size, ids.length)
  for (const id of ids) assert.equal(results.get(id), `canonical-${id}`)
  await assert.rejects(
    loadCanonicalEvidence(ids, async id => {
      if (id === '3') throw new Error('missing canonical source')
      return id
    }),
    /missing canonical source/
  )
})
