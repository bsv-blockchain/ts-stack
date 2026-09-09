import { getAdmissionStorage } from '../storage/AdmissionStorage.js'
import { referenceAdmissionStorageContract } from './admission/AdmissionStorageContract.js'

referenceAdmissionStorageContract()

describe('AdmissionStorage provider detection', () => {
  test('does not treat a missing provider as admission storage', () => {
    expect(getAdmissionStorage(undefined)).toBeUndefined()
    expect(getAdmissionStorage({ admission: null })).toBeUndefined()
  })
})
