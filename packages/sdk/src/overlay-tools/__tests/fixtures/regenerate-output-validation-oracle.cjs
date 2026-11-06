// Explicit maintenance command only. Never regenerate expected observations from
// the working SDK or a mutated source. The reference is the exact public tarball.
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { createHash } = require('node:crypto')
const { execFileSync } = require('node:child_process')
const { gzipSync, gunzipSync } = require('node:zlib')
const helper = require('./output-validation-cases.cjs')
const [archive] = process.argv.slice(2)
if (!archive || process.argv.length !== 3) throw new Error('Expected the public sdk-4.0.1.tgz path')
const file = path.join(__dirname, 'output-validation-4.0.1.json.gz')
const oracle = JSON.parse(gunzipSync(fs.readFileSync(file), { maxOutputLength: 16 * 1024 * 1024 }))
const bytes = fs.readFileSync(archive)
if (
  'sha512-' + createHash('sha512').update(bytes).digest('base64') !== oracle.source.integrity ||
  createHash('sha256').update(bytes).digest('hex') !== oracle.source.tarballSha256
)
  throw new Error('Public reference tarball integrity mismatch')
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-validation-reference-'))
try {
  execFileSync('/usr/bin/tar', ['-xzf', path.resolve(archive), '-C', temporary], { timeout: 30000 })
  const directory = path.join(temporary, 'package')
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json')))
  if (manifest.name !== '@bsv/sdk' || manifest.version !== '4.0.1')
    throw new Error('Unexpected reference package')
  fs.symlinkSync(
    path.resolve(__dirname, '../../../../node_modules'),
    path.join(directory, 'node_modules')
  )
  const modules = path.join(directory, 'dist/cjs/src/overlay-tools')
  const json = require(path.join(modules, 'OutputProtocolJSON.js'))
  const cases = helper.calls({
    json,
    protocol: require(path.join(modules, 'OutputProtocol.js')),
    schema: require(path.join(modules, 'OutputProtocolSchema.js'))
  })
  oracle.cases = Object.fromEntries(cases.map(entry => [entry.id, entry.observe()]))
  fs.writeFileSync(
    file,
    gzipSync(Buffer.from(JSON.stringify(oracle, null, 2) + '\n'), { level: 9 })
  )
  const budgets = {
    reference: oracle.source,
    cases: Object.fromEntries(
      helper.workloads().map(entry => {
        const measured = helper.nativeWork(() => json[entry.name](entry.input))
        return [
          entry.id,
          {
            maximumNativeCalls: Math.ceil(measured.calls * 1.15) + 8,
            referenceCalls: measured.calls
          }
        ]
      })
    )
  }
  fs.writeFileSync(
    path.join(__dirname, 'output-validation-work-budgets.json'),
    JSON.stringify(budgets, null, 2) + '\n'
  )
  console.log(
    `Generated ${cases.length} published-behavior cases and ${helper.workloads().length} work budgets.`
  )
} finally {
  fs.rmSync(temporary, { recursive: true, force: true })
}
