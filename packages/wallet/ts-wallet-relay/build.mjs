import { build, context } from 'esbuild'
import { rm } from 'node:fs/promises'

const watch = process.argv.includes('--watch')

await rm(new URL('./dist', import.meta.url), { recursive: true, force: true })

const shared = {
  bundle: true,
  entryPoints: {
    index: 'src/index.ts',
    client: 'src/client.ts',
    react: 'src/react.tsx',
  },
  external: [
    '@bsv/sdk',
    'crypto',
    'express',
    'http',
    'qrcode',
    'react',
    'react/jsx-runtime',
    'ws',
  ],
  logLevel: 'info',
  platform: 'node',
  sourcemap: true,
  splitting: false,
  target: 'es2020',
}

const builds = [
  {
    ...shared,
    format: 'esm',
    outdir: 'dist',
  },
  {
    ...shared,
    format: 'cjs',
    outExtension: { '.js': '.cjs' },
    outdir: 'dist',
  },
]

if (watch) {
  const contexts = await Promise.all(builds.map(options => context(options)))
  await Promise.all(contexts.map(buildContext => buildContext.watch()))
  console.log('Watching wallet relay entry points for changes...')
} else {
  await Promise.all(builds.map(options => build(options)))
}
