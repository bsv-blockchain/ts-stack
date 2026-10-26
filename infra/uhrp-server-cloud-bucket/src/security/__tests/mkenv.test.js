const { mkdtempSync, readFileSync, rmSync, statSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const {
  main,
  renderDispatchEnvironment,
  renderServiceManifest
} = require('../../../scripts/mkenv.cjs')

function deploymentEnvironment(overrides = {}) {
  return {
    SERVICE: 'uhrp-service',
    IMAGE: 'registry.example/uhrp:sha',
    NODE_ENV: 'production',
    PRICE_PER_GB_MO: '0.03',
    MIN_HOSTING_MINUTES: '15',
    HOSTING_DOMAIN: 'storage.example.com',
    ADMIN_TOKEN: 'admin-secret',
    SERVER_PRIVATE_KEY: 'private-key',
    GCP_STORAGE_CREDS: '{"private_key":"cloud-secret"}',
    GOOGLE_PROJECT_ID: 'project-from-setup',
    GCP_BUCKET_NAME: 'uhrp-bucket',
    WALLET_STORAGE_URL: 'https://wallet.example.com',
    BSV_NETWORK: 'mainnet',
    HTTP_PORT: '8080',
    ...overrides
  }
}

test('serializes multiline deployment values as inert YAML scalars', () => {
  const injected = 'safe\n        - name: INJECTED\n          value: attacker'
  const manifest = renderServiceManifest(
    deploymentEnvironment({ HOSTING_DOMAIN: injected, CHIRP_MAX_ACTIVE_SESSIONS: '64' })
  )

  expect(manifest).toContain(`value: ${JSON.stringify(injected)}`)
  expect(manifest).toContain(
    '        - name: GCP_PROJECT_ID\n          value: "project-from-setup"'
  )
  expect(manifest).toContain('        - name: CHIRP_MAX_ACTIVE_SESSIONS\n          value: "64"')
  expect(manifest).not.toContain('\n        - name: INJECTED\n')
  expect(renderDispatchEnvironment(deploymentEnvironment({ HOSTING_DOMAIN: injected }))).toContain(
    `HOSTING_DOMAIN: ${JSON.stringify(injected)}`
  )
})

test('writes private files without logging their secret contents', () => {
  const directory = mkdtempSync(join(tmpdir(), 'uhrp-mkenv-test-'))
  const servicePath = join(directory, 'service.yaml')
  const dispatchPath = join(directory, 'dispatch.yaml')
  const log = jest.spyOn(console, 'log').mockImplementation(() => {})
  try {
    main([servicePath, dispatchPath], deploymentEnvironment())

    expect(statSync(servicePath).mode & 0o777).toBe(0o600)
    expect(statSync(dispatchPath).mode & 0o777).toBe(0o600)
    expect(readFileSync(servicePath, 'utf8')).toContain('"private-key"')
    expect(readFileSync(dispatchPath, 'utf8')).toContain('"admin-secret"')
    expect(log.mock.calls.flat().join(' ')).not.toContain('admin-secret')
    expect(log.mock.calls.flat().join(' ')).not.toContain('private-key')
  } finally {
    log.mockRestore()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('fails closed when a required runtime value is absent', () => {
  expect(() => renderServiceManifest(deploymentEnvironment({ SERVER_PRIVATE_KEY: '' }))).toThrow(
    'SERVER_PRIVATE_KEY is required'
  )
})

test('uses runtime identity without requiring an embedded Google JSON key', () => {
  const environment = deploymentEnvironment({ GCP_STORAGE_CREDS: '' })
  const manifest = renderServiceManifest(environment)
  expect(manifest).not.toContain('GCP_STORAGE_CREDS')
  expect(manifest).not.toContain('cloud-secret')
})
