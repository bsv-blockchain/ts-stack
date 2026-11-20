import assert from 'node:assert/strict'
import test from 'node:test'
import { certificateText, findCertificate } from './ci-certificate.mjs'

const base = 'a'.repeat(40)
const head = 'b'.repeat(40)
const author = { login: 'ty-everett', databaseId: 23272461 }
const certificate = { author, body: certificateText(head), lastEditedAt: null, isMinimized: false }
const page = (nodes, pullRequest = {}) => ({
  data: {
    repository: {
      pullRequest: {
        state: 'OPEN',
        baseRefOid: base,
        headRefOid: head,
        comments: { nodes },
        ...pullRequest
      }
    }
  }
})

test('recognizes an exact certificate from each authenticated maintainer across pages', () => {
  for (const entry of [
    author,
    { login: 'sirdeggen', databaseId: 8416253 },
    { login: 'BraydenLangley', databaseId: 18727167 }
  ]) {
    const issued = { ...certificate, author: entry }
    assert.equal(findCertificate([page([]), page([issued])], base, head), issued)
  }
})

test('rejects stale, edited, hidden and unauthenticated certificate comments', () => {
  for (const rejected of [
    { ...certificate, body: certificateText('c'.repeat(40)) },
    { ...certificate, body: 'CI Certificate: local tests passed' },
    { ...certificate, lastEditedAt: '2026-11-20T00:00:00Z' },
    { ...certificate, isMinimized: true },
    { ...certificate, author: null },
    { ...certificate, author: { login: 'ty-everett', databaseId: 1 } },
    { ...certificate, author: { login: 'other-user', databaseId: 23272461 } }
  ]) {
    assert.equal(findCertificate([page([rejected])], base, head), undefined)
  }
})

test('requires current branch and base, and falls back when comment evidence is missing', () => {
  assert.equal(findCertificate([], base, head), undefined)
  assert.equal(findCertificate([page([])], base, head), undefined)
  assert.equal(findCertificate([page([certificate], { state: 'MERGED' })], base, head), undefined)
  assert.equal(
    findCertificate([page([certificate], { baseRefOid: 'c'.repeat(40) })], base, head),
    undefined
  )
  assert.equal(
    findCertificate([page([certificate], { headRefOid: 'c'.repeat(40) })], base, head),
    undefined
  )
  assert.equal(findCertificate([page([certificate]), {}], base, head), undefined)
})
