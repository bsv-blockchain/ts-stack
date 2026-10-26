'use strict'

const { closeSync, constants, fchmodSync, openSync, writeFileSync } = require('node:fs')

const RUNTIME_ENVIRONMENT = [
  'BSV_NETWORK',
  'KNEX_DB_CONNECTION',
  'SERVER_PRIVATE_KEY',
  'TAAL_API_KEY',
  'COMMISSION_FEE',
  'COMMISSION_PUBLIC_KEY',
  'FEE_MODEL'
]

function required(environment, name) {
  const value = environment[name]
  if (typeof value !== 'string' || value === '') throw new Error(`${name} is required`)
  return value
}

function render(environment) {
  const lines = [
    'apiVersion: serving.knative.dev/v1',
    'kind: Service',
    'metadata:',
    `  name: ${JSON.stringify(required(environment, 'SERVICE'))}`,
    '  labels:',
    '    cloud.googleapis.com/location: us-west1',
    'spec:',
    '  template:',
    '    spec:',
    '      timeoutSeconds: 3540',
    '      containers:',
    `      - image: ${JSON.stringify(required(environment, 'IMAGE'))}`,
    '        ports:',
    '        - name: h2c',
    '          containerPort: 8080',
    '        resources:',
    '          limits:',
    '            memory: "4Gi"',
    '        env:'
  ]
  for (const name of RUNTIME_ENVIRONMENT) {
    lines.push(`        - name: ${name}`, `          value: ${JSON.stringify(environment[name] ?? '')}`)
  }
  return `${lines.join('\n')}\n`
}

function writePrivate(path, contents) {
  const descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC, 0o600)
  try {
    fchmodSync(descriptor, 0o600)
    writeFileSync(descriptor, contents, 'utf8')
  } finally {
    closeSync(descriptor)
  }
}

function main(args, environment = process.env) {
  if (args.length !== 1 || args[0] === '') throw new Error('Usage: mkenv.sh <service-manifest-path>')
  writePrivate(args[0], render(environment))
  console.log('Deployment manifest generated without printing secret values.')
}

module.exports = { main, render }

if (require.main === module) main(process.argv.slice(2))
