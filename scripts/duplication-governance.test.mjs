import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { test } from 'node:test'

const root = fileURLToPath(new URL('..', import.meta.url))

test('reviewed duplication boundaries are explicit, owned, and time-bounded', async () => {
  const policy = JSON.parse(
    await readFile(join(root, 'governance/duplication-policy.json'), 'utf8')
  )
  assert.equal(policy.schemaVersion, 1)
  assert.ok(policy.principle.length > 100)
  assert.ok(policy.baseline.duplicatedLines > 0)
  const ids = policy.boundaries.map(boundary => boundary.id)
  assert.equal(new Set(ids).size, ids.length)

  const reviewed = new Date(`${policy.lastReviewed}T00:00:00Z`)
  for (const boundary of policy.boundaries) {
    assert.match(boundary.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    assert.ok(boundary.disposition.length > 5)
    assert.ok(boundary.reason.length > 100)
    assert.ok(boundary.removalProof.length > 100)
    assert.match(boundary.owner, /^[a-z0-9-]+$/)
    assert.ok(boundary.paths.length > 0)
    for (const path of boundary.paths) {
      assert.ok(existsSync(join(root, path)), `${boundary.id} references missing ${path}`)
    }
    const reviewBy = new Date(`${boundary.reviewBy}T00:00:00Z`)
    const reviewWindowDays = (reviewBy - reviewed) / 86_400_000
    assert.ok(reviewWindowDays > 0)
    assert.ok(reviewWindowDays <= policy.reviewCadenceDays)
  }
})
