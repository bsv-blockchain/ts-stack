import { build, context } from 'esbuild'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const shared = {
  bundle: true,
  entryPoints: {
    index: 'src/index.ts',
    client: 'src/client.ts',
    react: 'src/react.tsx'
  },
  external: [
    '@bsv/sdk',
    '@noble/curves/secp256k1.js',
    '@noble/hashes/hmac.js',
    '@noble/hashes/sha2.js',
    'crypto',
    'express',
    'http',
    'qrcode',
    'react',
    'react/jsx-runtime',
    'ws'
  ],
  logLevel: 'info',
  mangleProps: /^_/,
  minify: true,
  platform: 'node',
  sourcemap: true,
  splitting: false,
  target: 'es2020'
}

const builds = [
  {
    ...shared,
    format: 'esm',
    outdir: 'dist'
  },
  {
    ...shared,
    format: 'cjs',
    outExtension: { '.js': '.cjs' },
    outdir: 'dist'
  }
]

export async function buildWalletRelay({
  watch = process.argv.includes('--watch'),
  buildImplementation = build,
  contextImplementation = context,
  removeImplementation = rm
} = {}) {
  await removeImplementation(new URL('./dist', import.meta.url), { recursive: true, force: true })

  if (!watch) {
    await Promise.all(builds.map(options => buildImplementation(options)))
    return
  }

  const contexts = await Promise.all(builds.map(options => contextImplementation(options)))
  await Promise.all(contexts.map(buildContext => buildContext.watch()))
  console.log('Watching wallet relay entry points for changes...')
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await buildWalletRelay()
}
