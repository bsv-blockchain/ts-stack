import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const skippedDirectories = new Set(['.git', 'dist', 'node_modules', 'out'])
const inspectedExtensions = new Set([
  '',
  '.cjs',
  '.env',
  '.js',
  '.json',
  '.mjs',
  '.sh',
  '.ts',
  '.yaml',
  '.yml'
])
const credentialName =
  '[A-Z0-9_]*(?:PRIVATE_KEY|XPRIV|MNEMONIC|SECRET|TOKEN|PASSWORD|PASS)[A-Z0-9_]*'
const patterns = [
  { name: 'PEM private key', expression: /-----BEGIN (?:EC |RSA |OPENSSH )?PRIVATE KEY-----/gu },
  { name: 'extended private key', expression: /\b(?:xprv|tprv)[1-9A-HJ-NP-Za-km-z]{100,120}\b/gu },
  {
    name: 'WIF private key assignment',
    expression: new RegExp(
      `^\\s*(?:-\\s*)?${credentialName}\\s*[:=]\\s*["']?[5KL][1-9A-HJ-NP-Za-km-z]{50,51}["']?(?:\\s|$)`,
      'gmu'
    )
  },
  {
    name: '32-byte private key assignment',
    expression: new RegExp(
      `^\\s*(?:-\\s*)?${credentialName}\\s*[:=]\\s*["']?(?:0x)?[0-9a-f]{64}["']?(?:\\s|$)`,
      'gimu'
    )
  },
  {
    name: 'wallet developer-key entry',
    expression: /^\s*["'][0-9a-f]{66}["']\s*:\s*["'][0-9a-f]{64}["']\s*,?\s*$/gimu
  },
  {
    name: 'TAAL API key assignment',
    expression:
      /^\s*(?:MAIN|TEST)_TAAL_API_KEY\s*=\s*["']?(?:mainnet|testnet)_[0-9a-f]{24,}["']?\s*$/gimu
  }
]

function filesUnder(relativePath) {
  const absolute = path.join(repositoryRoot, relativePath)
  if (!fs.existsSync(absolute)) return []
  const details = fs.statSync(absolute)
  if (details.isFile()) return [absolute]
  const files = []
  for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
    if (skippedDirectories.has(entry.name)) continue
    const child = path.join(absolute, entry.name)
    if (entry.isDirectory()) files.push(...filesUnder(path.relative(repositoryRoot, child)))
    else if (
      entry.name !== 'package-lock.json' &&
      inspectedExtensions.has(path.extname(entry.name)) &&
      fs.statSync(child).size <= 1024 * 1024
    ) {
      files.push(child)
    }
  }
  return files
}

function findingsIn(source) {
  const findings = []
  for (const pattern of patterns) {
    pattern.expression.lastIndex = 0
    for (const match of source.matchAll(pattern.expression)) {
      findings.push({
        kind: pattern.name,
        line: source.slice(0, match.index).split('\n').length
      })
    }
  }
  return findings
}

test('deployable configuration contains no literal private-key material', () => {
  const files = [
    ...filesUnder('.github'),
    ...filesUnder('apps'),
    ...filesUnder('infra'),
    ...filesUnder('secrets'),
    ...filesUnder('packages').filter(file => path.basename(file).startsWith('.env')),
    ...[
      '.env',
      '.env.example',
      'compose.yaml',
      'compose.yml',
      'docker-compose.yaml',
      'docker-compose.yml'
    ]
      .map(file => path.join(repositoryRoot, file))
      .filter(file => fs.existsSync(file))
  ]
  const findings = files.flatMap(file =>
    findingsIn(fs.readFileSync(file, 'utf8')).map(finding => ({
      file: path.relative(repositoryRoot, file),
      ...finding
    }))
  )
  assert.deepEqual(findings, [])
})

test('private-key detection covers deployment-shaped literals', () => {
  assert.deepEqual(
    findingsIn(
      [
        'SERVER_PRIVATE_KEY=' + '01'.repeat(32),
        'SERVER_XPRIV=xprv' + '1'.repeat(107),
        '-----BEGIN PRIVATE KEY-----',
        `"${'02' + '11'.repeat(32)}": "${'22'.repeat(32)}"`,
        "MAIN_TAAL_API_KEY='mainnet_" + '33'.repeat(16) + "'"
      ].join('\n')
    ).map(finding => finding.kind),
    [
      'PEM private key',
      'extended private key',
      '32-byte private key assignment',
      'wallet developer-key entry',
      'TAAL API key assignment'
    ]
  )
})
