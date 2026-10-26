import { describe, expect, test } from '@jest/globals'
import ts from 'typescript'
import { walletConnect } from '../wallet-connect'
import { assembleBaseFile, newBuilder, SERVER_TEMPLATE } from '../../scaffold/base-app'

const ctx = {
  name: 'demo',
  network: 'test' as const,
  bsvDir: 'src/bsv',
  stack: { frontend: { framework: 'react' as const, variant: 'react-ts' } },
  layout: 'frontend-only' as const
}

describe('wallet-connect', () => {
  test('id + defaultSelected + roles', () => {
    expect(walletConnect.id).toBe('wallet-connect')
    expect(walletConnect.defaultSelected).toBe(true)
    expect(walletConnect.roles).toEqual(['shared', 'client', 'server'])
  })
  test('shared helper is the @bsv/auth proof primitive (object-arg API)', () => {
    const shared = walletConnect.files(ctx).shared ?? []
    const auth = shared.find(f => f.path === 'auth.ts')
    expect(auth).toBeDefined()
    expect(auth?.content).toContain('AuthProofClient')
    expect(auth?.content).toContain('createAuthProof({') // object-arg, NOT positional
    expect(auth?.content).not.toMatch(/createAuthProof\(\s*wallet\s*,/) // guard the old positional bug
  })
  test('client gets acquisition helper and all three context files (bare paths, always emitted)', () => {
    const client = walletConnect.files(ctx).client ?? []
    const paths = client.map(f => f.path)
    expect(paths).toContain('walletAcquisition.ts')
    expect(paths).toContain('WalletConnectionContext.tsx')
    expect(paths).toContain('WalletContext.tsx')
    expect(paths).toContain('WalletProviders.tsx')
  })
  test('ships a shared bsv.css theme (accent #2196F3) imported by WalletProviders', () => {
    const client = walletConnect.files(ctx).client ?? []
    const css = client.find(f => f.path === 'bsv.css')
    expect(css?.content).toContain('--bsv-accent: #2196F3')
    expect(css?.content).toContain('.bsv-page')
    const providers = client.find(f => f.path === 'WalletProviders.tsx')
    expect(providers?.content).toContain("import './bsv.css'")
  })
  test('client ships serverIdentity helper that fetches the baseline /api/identity route', () => {
    const client = walletConnect.files(ctx).client ?? []
    const helper = client.find(f => f.path === 'serverIdentity.ts')
    expect(helper).toBeDefined()
    expect(helper?.content).toContain('export async function getServerIdentity')
    expect(helper?.content).toContain('/api/identity')
    expect(helper?.content).toContain('PublicKey.fromString')
    expect(helper?.content).toContain('endpoint/TLS trust')
    expect(helper?.content).toContain('Object.keys(descriptors).length !== 1')
  })
  test('generated API client fixes origin, redirect, deadline, byte, and UTF-8 boundaries', () => {
    const client = walletConnect.files(ctx).client ?? []
    const apiClient = client.find(f => f.path === 'apiClient.ts')
    const config = client.find(f => f.path === 'config.ts')
    expect(apiClient?.content).toContain("redirect: 'error'")
    expect(apiClient?.content).toContain("credentials: 'omit'")
    expect(apiClient?.content).toContain('API_TIMEOUT_MS = 10_000')
    expect(apiClient?.content).toContain('MAX_API_RESPONSE_BYTES')
    expect(apiClient?.content).toContain("response.headers.get('content-encoding')")
    expect(apiClient?.content).toContain('API request body must be a string')
    expect(apiClient?.content).toContain("new TextDecoder('utf-8', { fatal: true })")
    expect(config?.content).toContain('VITE_API_URL is required in production')
    expect(config?.content).toContain("parsedApiUrl.protocol !== 'https:'")
    expect(config?.content).toContain('VITE_BSV_NETWORK must be main, test, or ttn')
  })
  test('generated wallet-connect TypeScript is syntactically valid', () => {
    const files = walletConnect.files(ctx)
    const generated = [
      ...(files.shared ?? []),
      ...(files.client ?? []),
      ...(files.server ?? [])
    ].filter(file => /\.tsx?$/.test(file.path))
    for (const file of generated) {
      const result = ts.transpileModule(file.content, {
        fileName: file.path,
        reportDiagnostics: true,
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
          jsx: ts.JsxEmit.ReactJSX
        }
      })
      const messages = (result.diagnostics ?? []).map(diagnostic =>
        ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
      )
      expect(messages).toEqual([])
    }
  })
  test('apiClient type-checks under the strict DOM lib the Vite client uses', () => {
    const apiClient = (walletConnect.files(ctx).client ?? []).find(f => f.path === 'apiClient.ts')
    const sources: Record<string, string> = {
      'apiClient.ts': apiClient?.content ?? '',
      'config.ts':
        "export const API_BASE_URL = 'http://localhost:3000'\nexport const API_ORIGIN = 'http://localhost:3000'\n"
    }
    const options: ts.CompilerOptions = {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      lib: ['lib.es2023.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
      strict: true,
      noEmit: true,
      types: []
    }
    const host = ts.createCompilerHost(options)
    const readFile = host.readFile.bind(host)
    host.fileExists = fileName => fileName in sources || ts.sys.fileExists(fileName)
    host.readFile = fileName => sources[fileName] ?? readFile(fileName)
    host.getSourceFile = (fileName, languageVersion) => {
      const text = host.readFile(fileName)
      return text === undefined ? undefined : ts.createSourceFile(fileName, text, languageVersion)
    }
    host.resolveModuleNames = names =>
      names.map(name => ({ resolvedFileName: name.replace(/^\.\/(.*)\.js$/, '$1.ts') }))
    const program = ts.createProgram(['apiClient.ts'], options, host)
    const messages = ts
      .getPreEmitDiagnostics(program)
      .map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n'))
    expect(messages).toEqual([])
  })
  test('server ships bounded nonce replay protection shared by auth routes', () => {
    const nonceStore = (walletConnect.files(ctx).server ?? []).find(f => f.path === 'nonceStore.ts')
    expect(nonceStore?.content).toContain('MAX_NONCES = 10_000')
    expect(nonceStore?.content).toContain('pruneExpired')
    expect(nonceStore?.content).toContain('usedNonces.has(nonce)')
  })
  test('glue is undefined (contexts moved to core files)', () => {
    expect(walletConnect.glue).toBeUndefined()
  })
  test('baseEdits wraps App in WalletProviders (assembler path)', () => {
    const b = newBuilder()
    walletConnect.baseEdits?.({ builder: b, ctx })
    expect(b.main.imports.join()).toContain('WalletProviders')
    expect(b.main.wraps).toEqual([{ open: '<WalletProviders>', close: '</WalletProviders>' }])
  })
  test('baseEdits mounts the WalletRelayService on the server (relay needs a backend)', () => {
    const b = newBuilder()
    walletConnect.baseEdits?.({ builder: b, ctx })
    expect(b.server.imports.join()).toContain(
      "import { WalletRelayService } from '@bsv/wallet-relay'"
    )
    expect(b.server.setup.join()).toContain(
      'new WalletRelayService({ app, server, wallet: serverWallet'
    )
  })
  test('server pairs phones via SERVER_ORIGIN: own /api/session registered before the relay', () => {
    const b = newBuilder()
    walletConnect.baseEdits?.({ builder: b, ctx })
    expect(b.server.config.map(c => c.import)).toEqual([
      "import { SERVER_ORIGIN, RELAY_URL } from './bsv/config.js'"
    ])
    const setup = b.server.setup.join('\n')
    const route = setup.indexOf("app.get('/api/session',")
    const relay = setup.indexOf('new WalletRelayService(')
    expect(route).toBeGreaterThanOrEqual(0)
    expect(route).toBeLessThan(relay) // Express matches the first registered route
    expect(setup).toContain('relay.createSession({ origin: SERVER_ORIGIN })')
    expect(setup).toContain("res.setHeader('Cache-Control', 'no-store, max-age=0')")
    expect(setup).toMatch(/code === 429 \? 429/)
    expect(setup).toMatch(/includes\('allowedOrigins'\) \? 403 : 500/)
    expect(setup).toContain('origin: SERVER_ORIGIN, relayUrl: RELAY_URL')
    expect(setup).not.toContain('CLIENT_ORIGIN')
    expect(setup).toMatch(/console\.log\(.*SERVER_ORIGIN/)
    const index = assembleBaseFile(SERVER_TEMPLATE, b, ctx)
    const result = ts.transpileModule(index, {
      fileName: 'index.ts',
      reportDiagnostics: true,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
    })
    expect(result.diagnostics ?? []).toEqual([])
    // Glued entry imports the values from the generated config.ts rather than inlining them.
    expect(index).toContain("import { SERVER_ORIGIN, RELAY_URL } from './bsv/config.js'")
    expect(index).not.toContain('isLocalDevelopmentHost')
    expect(index.indexOf('const server = http.createServer(app)')).toBeLessThan(
      index.indexOf("app.get('/api/session',")
    )
  })
  test.each([
    ['development', true],
    ['production', false]
  ])('startup log in %s: LAN pairing hint %s', (nodeEnv, hint) => {
    const b = newBuilder()
    walletConnect.baseEdits?.({ builder: b, ctx })
    const js = ts.transpileModule(b.server.setup.join('\n'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
    }).outputText
    const logs: string[] = []
    class WalletRelayService {}
    new Function(
      'app',
      'server',
      'serverWallet',
      'WalletRelayService',
      'SERVER_ORIGIN',
      'RELAY_URL',
      'process',
      'console',
      js
    )(
      { get: () => undefined },
      {},
      {},
      WalletRelayService,
      'https://api.example.com',
      'wss://api.example.com',
      { env: { NODE_ENV: nodeEnv } },
      { log: (m: string) => logs.push(m) }
    )
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('https://api.example.com')
    expect(logs[0].includes('LAN address')).toBe(hint)
  })
  test('server relay allows private-network HTTP only outside production', () => {
    const b = newBuilder()
    walletConnect.baseEdits?.({ builder: b, ctx })
    const setup = b.server.setup.join('\n')
    expect(setup).toMatch(
      /new WalletRelayService\(\{[^)]*allowLocalNetworkHttp: process\.env\.NODE_ENV !== 'production'[^)]*\}\)/
    )
  })
  test('relay client allows private-network HTTP only in the Vite dev build', () => {
    const provider = (walletConnect.files(ctx).client ?? []).find(
      f => f.path === 'WalletConnectionContext.tsx'
    )
    expect(provider?.content).toMatch(
      /useWalletRelayClient\(\{[^)]*allowLocalNetworkHttp: import\.meta\.env\.DEV[^)]*\}\)/
    )
  })
  test('relay client points at the server via API_BASE_URL', () => {
    const provider = (walletConnect.files(ctx).client ?? []).find(
      f => f.path === 'WalletConnectionContext.tsx'
    )
    expect(provider?.content).toContain('apiUrl = API_BASE_URL')
    expect(provider?.content).toContain("from './config.js'")
  })
  test('deps name the right packages', () => {
    expect(Object.keys(walletConnect.npmDependencies(ctx).shared ?? {})).toContain('@bsv/auth')
    expect(Object.keys(walletConnect.npmDependencies(ctx).shared ?? {})).toContain('@bsv/sdk')
    const client = walletConnect.npmDependencies(ctx).client ?? {}
    expect(Object.keys(client)).toEqual(expect.arrayContaining(['@bsv/wallet-relay', 'react']))
    expect(Object.keys(client)).not.toContain('@bsv/sdk')
    // server gets the relay + its qrcode peer (ws is the relay's own dependency since 0.5)
    const server = walletConnect.npmDependencies(ctx).server ?? {}
    expect(Object.keys(server)).toEqual(expect.arrayContaining(['@bsv/wallet-relay', 'qrcode']))
    expect(server).not.toHaveProperty('ws')
  })
  test('deps target @bsv/wallet-relay 0.7.0 (allowLocalNetworkHttp opt-in) and its @bsv/sdk peer floor', () => {
    const deps = walletConnect.npmDependencies(ctx)
    expect(deps.client?.['@bsv/wallet-relay']).toBe('^0.7.0')
    expect(deps.server?.['@bsv/wallet-relay']).toBe('^0.7.0')
    expect(deps.shared?.['@bsv/sdk']).toBe('^2.4.1')
  })
  test('wallet-connect provides ConnectWallet + client config and only main.* baseEdits (Home is a generated base file)', () => {
    const ctx2 = {
      name: 'd',
      network: 'test' as const,
      bsvDir: 'src/bsv',
      stack: { frontend: { framework: 'react' as const, variant: 'react-ts' } },
      layout: 'frontend-only' as const
    }
    const client = (walletConnect.files(ctx2).client ?? []).map(f => f.path)
    expect(client).toEqual(
      expect.arrayContaining([
        'ConnectWallet.tsx',
        'apiClient.ts',
        'config.ts',
        'WalletContext.tsx'
      ])
    )
    expect(client).not.toContain('Home.tsx') // Home is assembled from HOME_TEMPLATE, not a capability file
    const b = newBuilder()
    walletConnect.baseEdits?.({ builder: b, ctx: ctx2 })
    expect(b.main.wraps).toEqual([{ open: '<WalletProviders>', close: '</WalletProviders>' }])
    expect(b.main.imports.join()).toContain('WalletProviders')
    expect(b.app.routes).toEqual([]) // route-free toolkit
    expect(b.server.routes).toEqual([])
    expect(walletConnect.npmDependencies(ctx2).shared).toHaveProperty('@bsv/sdk')
    expect(walletConnect.npmDependencies(ctx2).client).toHaveProperty('react-router-dom')
  })
  test('WalletContext is a connect state machine (connect/connectMobile/cancel/status)', () => {
    const wc = (
      walletConnect.files({
        name: 'd',
        network: 'test',
        bsvDir: 'src/bsv',
        stack: {},
        layout: 'frontend-only'
      } as any).client ?? []
    ).find(f => f.path === 'WalletContext.tsx')
    for (const s of ['connect', 'connectMobile', 'cancel', 'status'])
      expect(wc?.content).toContain(s)
  })
  test("agentsSection has the How it works / How it's used / Future integrations structure", () => {
    const md = walletConnect.agentsSection(ctx)
    expect(md).toContain('### How it works')
    expect(md).toContain("### How it's used")
    expect(md).toContain('### Future integrations')
  })
})
