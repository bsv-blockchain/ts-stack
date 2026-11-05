import { afterAll, beforeAll, expect, it } from '@jest/globals'
import { privatePublicationEngineFixture } from './PrivatePublicationEngine.fixture.js'
import { coordinatorFixture } from '../../../../application/output-knowledge/test/private-publication-coordinator-fixture.js'
import { PrivatePublicationCoordinator } from '../../../../application/output-knowledge/src/private/PrivatePublicationCoordinator.js'
import { PrivatePublicationDisclosure } from '../../../../application/output-knowledge/src/private/PrivatePublicationDisclosure.js'
import { allow } from '../../../../application/output-knowledge/test/private-publication-fixture.js'
let replica: Awaited<ReturnType<typeof privatePublicationEngineFixture>>
beforeAll(async () => {
  replica = await privatePublicationEngineFixture()
}, 120000)
afterAll(async () => {
  await replica?.close()
}, 60000)
it('composes actual SDK Script/SPV, native SQLite, Engine/Mongo admission, original recovery and physical disclosure', async () => {
  const f = coordinatorFixture(),
    first = await replica.install(f, 'full-private-service', true)
  const coordinator = new PrivatePublicationCoordinator({ ...f.options, admission: first.bridge })
  const result = await coordinator.publish(f.contract.request, f.caller)
  expect(result.status).toBe('ready')
  expect(first.submissions).toBe(1)
  expect(first.calls.some(call => JSON.stringify(call.privateValues) === '[1,2,3]')).toBe(true)
  const initial = f.store.loadVerified(f.status.publicationId, () => '20', allow)!
  expect(initial.binding.phase).toBe('active')
  if (!('admission' in initial.fence.state.progress)) throw new Error('Expected retained admission')
  expect(initial.fence.state.progress.admission.assessmentContextId).toMatch(
    /^overlay-topic-admission-v1:/
  )
  const publicOutput = await first.storage.findOutput(
    f.contract.request.evidence.txid,
    0,
    f.contract.request.topic
  )
  expect(publicOutput).toBeDefined()
  expect(publicOutput).not.toHaveProperty('privateValues')
  await coordinator.stop()
  await first.storage.close()
  const next = await replica.install(f, 'full-private-service')
  const reopened = f.reopen()
  const recovered = new PrivatePublicationCoordinator({
    ...f.options,
    store: reopened,
    admission: next.bridge
  })
  f.time('101')
  await expect(recovered.publish(f.contract.request, f.caller)).resolves.toEqual(result)
  expect(next.submissions).toBe(0)
  expect(next.calls).toHaveLength(0)
  expect(reopened.loadVerified(f.status.publicationId, () => '101', allow)!.original).toEqual(
    initial.original
  )
  const disclosure = new PrivatePublicationDisclosure(
    f.native.owner,
    reopened,
    f.contract.contracts,
    f.options.access,
    f.options.clock
  )
  const response = disclosure.prepare(f.status, f.caller)
  let sends = 0
  response.enqueue(body => {
    sends++
    expect(JSON.parse(body)).toEqual(result)
  })
  expect(sends).toBe(1)
  const revoked = disclosure.prepare(f.status, f.caller)
  f.revokeAccess()
  expect(() =>
    revoked.enqueue(() => {
      sends++
    })
  ).toThrow('Private publication not found')
  expect(sends).toBe(1)
  await recovered.stop()
}, 30000)
