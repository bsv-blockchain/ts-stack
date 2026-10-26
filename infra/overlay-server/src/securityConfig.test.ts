import assert from 'node:assert/strict'
import test from 'node:test'
import { PrivateKey } from '@bsv/sdk'
import { readBooleanEnv, readMandalaRuntimeConfiguration } from './securityConfig.js'

const key = (value: number): string => value.toString(16).padStart(64, '0')

test('boolean configuration rejects ambiguous values instead of weakening a true default', () => {
  assert.equal(readBooleanEnv({}, 'STRICT_MODE', true), true)
  assert.equal(readBooleanEnv({ STRICT_MODE: 'false' }, 'STRICT_MODE', true), false)
  assert.equal(readBooleanEnv({ STRICT_MODE: '0' }, 'STRICT_MODE', true), false)
  assert.throws(
    () => readBooleanEnv({ STRICT_MODE: 'treu' }, 'STRICT_MODE', true),
    /must be one of/
  )
})

test('Mandala remains disabled without privileged configuration', () => {
  assert.deepEqual(readMandalaRuntimeConfiguration({}, key(1)), { enabled: false })
})

test('Mandala requires independent authority roots and explicit screening data', () => {
  assert.throws(
    () =>
      readMandalaRuntimeConfiguration(
        {
          MANDALA_ENABLED: 'true',
          MANDALA_VERIFIER_PRIVATE_KEY: key(1),
          MANDALA_ADMIN_PRIVATE_KEY: key(2),
          MANDALA_STATIC_DENYLIST_JSON: '[]'
        },
        key(1)
      ),
    /must be independent/
  )
  assert.throws(
    () =>
      readMandalaRuntimeConfiguration(
        {
          MANDALA_ENABLED: 'true',
          MANDALA_VERIFIER_PRIVATE_KEY: key(2),
          MANDALA_ADMIN_PRIVATE_KEY: key(3)
        },
        key(1)
      ),
    /MANDALA_STATIC_DENYLIST_JSON/
  )
})

test('Mandala validates and canonicalizes its explicit static denylist', () => {
  const sanctioned = PrivateKey.fromHex(key(4)).toPublicKey().toString().toUpperCase()
  const config = readMandalaRuntimeConfiguration(
    {
      MANDALA_ENABLED: 'true',
      MANDALA_VERIFIER_PRIVATE_KEY: key(2),
      MANDALA_ADMIN_PRIVATE_KEY: key(3),
      MANDALA_STATIC_DENYLIST_JSON: JSON.stringify([sanctioned])
    },
    key(1)
  )
  assert.equal(config.enabled, true)
  if (config.enabled) {
    assert.deepEqual(config.sanctionedIdentityKeys, [sanctioned.toLowerCase()])
  }

  assert.throws(
    () =>
      readMandalaRuntimeConfiguration(
        {
          MANDALA_ENABLED: 'true',
          MANDALA_VERIFIER_PRIVATE_KEY: key(2),
          MANDALA_ADMIN_PRIVATE_KEY: key(3),
          MANDALA_STATIC_DENYLIST_JSON: '["not-a-key"]'
        },
        key(1)
      ),
    /compressed secp256k1/
  )
})
