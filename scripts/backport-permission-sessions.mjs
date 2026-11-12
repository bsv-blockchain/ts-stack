// Rebuild a narrow, source-derived permission backport in an unpacked immutable
// Toolbox artifact. Other wallet/storage/crypto code stays byte-for-byte intact.
// Usage: node scripts/backport-permission-sessions.mjs /absolute/unpacked/package
import { readFile, writeFile, readdir, unlink } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
const require = createRequire(
  new URL('../packages/wallet/wallet-toolbox/package.json', import.meta.url)
)
const ts = require('typescript')
const source = await readFile(
  new URL('../packages/wallet/wallet-toolbox/src/WalletPermissionsManager.ts', import.meta.url),
  'utf8'
)
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
}).outputText
function parse(code) {
  return ts.createSourceFile('artifact.ts', code, ts.ScriptTarget.Latest, true)
}
function findClass(file) {
  let found
  function visit(node) {
    if (
      (ts.isClassDeclaration(node) || ts.isClassExpression(node)) &&
      node.members.some(m => m.name?.getText(file) === 'ensureLabelAccess')
    )
      found = node
    if (!found) ts.forEachChild(node, visit)
  }
  visit(file)
  if (!found) throw Error('Expected one WalletPermissionsManager class')
  return found
}
const reference = parse(compiled)
const klass = findClass(reference)
const method = name =>
  klass.members.find(m => m.name?.getText(reference) === name).getText(reference)
function sessionBlock(name) {
  let block
  function visit(node) {
    if (
      ts.isIfStatement(node) &&
      node.expression.getText(reference) === 'params.sessionDurationMs !== undefined'
    )
      block = node.getText(reference)
    else ts.forEachChild(node, visit)
  }
  visit(klass.members.find(member => member.name?.getText(reference) === name))
  if (!block) throw Error('Missing source session grant block')
  return block
}

function once(text, before, after) {
  if (!text.includes(before) || text.indexOf(before) !== text.lastIndexOf(before))
    throw Error(`Unexpected source preimage: ${before}`)
  return text.replace(before, after)
}
const directory = process.argv[2]
if (!directory || !directory.startsWith('/'))
  throw Error('Pass an absolute unpacked package directory')
async function artifactFiles(directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await artifactFiles(path)))
    else if (
      /index\.(client|mobile)\.(mjs|cjs|d\.mts|d\.cts)$/.test(entry.name) ||
      /^WalletPermissionsManager\.(js|d\.ts)$/.test(entry.name)
    )
      files.push(path)
  }
  return files
}
const metadata = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'))
if (
  !['@bsv/wallet-toolbox', '@bsv/wallet-toolbox-client', '@bsv/wallet-toolbox-mobile'].includes(
    metadata.name
  )
)
  throw Error('Unexpected Toolbox package')
const outputs = []
for (const path of await artifactFiles(resolve(directory, 'out'))) {
  const entry = path.slice(directory.length + 1)
  let code = await readFile(path, 'utf8')
  if (code.includes('sessionPermissions = new Map') || code.includes('listSessionPermissions()'))
    throw Error('Artifact already contains session permissions')
  const declaration = entry.includes('.d.')
  const file = parse(code),
    owner = findClass(file),
    edits = []
  for (const member of owner.members) {
    const name = member.name?.getText(file)
    let replacement
    if (declaration) {
      if (name === 'ensureProtocolPermission') {
        const parameterType = member.parameters[0]?.type
        if (!parameterType || !ts.isTypeLiteralNode(parameterType))
          throw Error('Unsupported protocol declaration')
        const text = member.getText(file),
          at = parameterType.end - member.getStart(file) - 1
        replacement =
          text.slice(0, at) +
          'moduleDetails?: { scheme: string; operation: string; point: string; keyID: string };' +
          text.slice(at)
      }
      if (name === 'grantPermission' || name === 'grantGroupedPermission')
        replacement = member
          .getText(file)
          .replace('params: {', 'params: { sessionDurationMs?: number;')
    } else if (
      ['ensureLabelAccess', 'isPermissionCached', 'maybeRequestGroupedPermissions'].includes(name)
    )
      replacement = method(name)
    else if (name === 'grantPermission') {
      replacement = member.getText(file)
      replacement = once(
        replacement,
        'this.activeRequests.delete(params.requestID);',
        'this.activeRequests.delete(params.requestID);'
      )
      // Validate and store before resolving even one waiter.
      replacement = once(
        replacement,
        'for (const x of matching.pending)',
        sessionBlock('grantPermission') + '\nfor (const x of matching.pending)'
      )
      replacement = once(
        replacement,
        'if (params.ephemeral)',
        'if (params.ephemeral || params.sessionDurationMs !== undefined)'
      )
    } else if (name === 'ensureProtocolPermission') {
      // Copy the owning permission method, including module presentation metadata.
      // No storage, persistence format or database code is included.
      replacement = method(name)
    } else if (name === 'grantGroupedPermission') {
      const newMethod = klass.members.find(m => m.name?.getText(reference) === name)
      let block
      function visit(n) {
        if (
          ts.isIfStatement(n) &&
          n.expression.getText(reference) === 'params.sessionDurationMs !== undefined'
        )
          block = n.getText(reference)
        else ts.forEachChild(n, visit)
      }
      visit(newMethod)
      replacement = once(
        member.getText(file),
        'this.validateGrantedPermissionsSubset(params.granted, requestedPermissions);',
        'this.validateGrantedPermissionsSubset(params.granted, requestedPermissions);\n' + block
      )
    } else if (name === 'revokePermission' || name === 'revokePermissions') {
      replacement = member.getText(file)
      const body = member.body.getStart(file) - member.getStart(file) + 1
      const invalidate =
        name === 'revokePermission'
          ? 'this.revokeSessionPermissions(oldToken.originator);'
          : 'for (const origin of new Set(oldTokens.map(token => token.originator))) this.revokeSessionPermissions(origin);'
      replacement = replacement.slice(0, body) + invalidate + replacement.slice(body)
    } else if (name === 'requestPermissionFlowCore') {
      replacement = member.getText(file)
      const statements = [...member.body.statements]
      const named = name =>
        statements.findIndex(
          node =>
            ts.isVariableStatement(node) &&
            node.declarationList.declarations[0]?.name.getText(file) === name
        )
      const begin = named('peerGroupResult'),
        end = named('groupResult')
      if (begin < 0 || end < begin || !ts.isIfStatement(statements[end + 1]))
        throw Error('Unsupported grouped-flow preimage')
      const full =
        'const groupResult = await this.resolveGroupedFlow(preparedRequest, key);\nif (groupResult !== null) return groupResult;'
      const start = statements[begin].getStart(file) - member.getStart(file)
      const finish = statements[end + 1].end - member.getStart(file)
      replacement =
        replacement.slice(0, start) +
        `if (this.config.preferAppPermissionGroups) { ${full} }\nconst peerGroupResult = await this.maybeRequestPeerGroupedLevel2ProtocolPermissions(preparedRequest);\nif (peerGroupResult !== null) return peerGroupResult;\nif (!this.config.preferAppPermissionGroups) { ${full} }` +
        replacement.slice(finish)
    }
    if (replacement)
      edits.push({ start: member.getStart(file), end: member.end, text: replacement })
  }
  const added = declaration
    ? 'listSessionPermissions(): Array<{ request: PermissionRequest; expiresAt: number }>;\nrevokeSessionPermissions(originator?: string): void;\nhasDeclaredProtocolPermission(params: { originator: string; protocolID: WalletProtocol; counterparty: string }): Promise<boolean>;'
    : 'sessionPermissions = new Map();\n' +
      [
        'hasDeclaredProtocolPermission',
        'copySessionRequest',
        'validateSessionDuration',
        'saveSessionPermission',
        'listSessionPermissions',
        'revokeSessionPermissions'
      ]
        .map(method)
        .join('\n')
  edits.push({ start: owner.end - 1, end: owner.end - 1, text: '\n' + added + '\n' })
  if (declaration) {
    for (const node of file.statements) {
      if (ts.isInterfaceDeclaration(node) && node.name.text === 'PermissionsManagerConfig')
        edits.push({
          start: node.end - 1,
          end: node.end - 1,
          text: '\ndifferentiateActionLabelOperations?: boolean;\npreferAppPermissionGroups?: boolean;\n'
        })
      if (ts.isInterfaceDeclaration(node) && node.name.text === 'PermissionRequest')
        edits.push({
          start: node.end - 1,
          end: node.end - 1,
          text: "\nmoduleDetails?: { scheme: string; operation: string; point: string; keyID: string };\nactionLabel?: { label: string; operation: 'apply' | 'list' };\n"
        })
    }
  }
  for (const edit of edits.sort((a, b) => b.start - a.start))
    code = code.slice(0, edit.start) + edit.text + code.slice(edit.end)
  code = code.replace(/\/\/# sourceMappingURL=.*$/gm, '')
  const diagnostics = parse(code).parseDiagnostics
  if (diagnostics.length)
    throw Error(`Invalid generated syntax in ${entry}: ${diagnostics[0].messageText}`)
  outputs.push({ path, code, entry })
}
if (!outputs.length) throw Error('No supported Toolbox artifacts found')
for (const { path, code, entry } of outputs) {
  await writeFile(path, code)
  // Upstream maps describe the pristine artifact and must not misidentify lines.
  await unlink(path + '.map').catch(error => {
    if (error.code !== 'ENOENT') throw error
  })
  console.log(entry)
}
