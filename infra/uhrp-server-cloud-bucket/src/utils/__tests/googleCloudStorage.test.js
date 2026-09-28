const mockStorage = jest.fn()
jest.mock('@google-cloud/storage', () => ({ Storage: function (options) { mockStorage(options) } }))
const { createGoogleCloudStorage } = require('../googleCloudStorage')
beforeEach(() => mockStorage.mockClear())
test('uses explicit configured credentials and project for private storage operations', () => {
  const credentials = { type: 'service_account', client_email: 'synthetic@example.test', private_key: 'synthetic-only' }
  createGoogleCloudStorage({ GCP_PROJECT_ID: 'synthetic-project', GCP_STORAGE_CREDS: JSON.stringify(credentials) })
  expect(mockStorage).toHaveBeenCalledWith({ projectId: 'synthetic-project', credentials })
})
test('retains application-default authentication only when credentials are unset', () => {
  createGoogleCloudStorage({ GCP_PROJECT_ID: 'synthetic-project' })
  expect(mockStorage).toHaveBeenCalledWith({ projectId: 'synthetic-project', credentials: undefined })
})
test.each(['not-json-secret', 'null', '[]', '"string"'])('rejects malformed configured credentials without falling back or exposing them', value => {
  expect(() => createGoogleCloudStorage({ GCP_STORAGE_CREDS: value })).toThrow('GCP_STORAGE_CREDS must contain a JSON credentials object')
  expect(mockStorage).not.toHaveBeenCalled()
})
