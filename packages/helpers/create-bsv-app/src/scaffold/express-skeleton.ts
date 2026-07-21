// src/scaffold/express-skeleton.ts
import { basename } from 'node:path'
import { writeFiles } from '../engine.js'
import type { FileSpec } from '../types.js'
import type { BaseScaffolder } from './base-scaffolder.js'

function files (name: string): FileSpec[] {
  const pkg = {
    name,
    private: true,
    type: 'module',
    scripts: { dev: 'tsx watch src/index.ts', build: 'tsc', start: 'node dist/index.js' },
    dependencies: { express: '^5.0.0', cors: '^2.8.5' },
    devDependencies: { '@types/express': '^5.0.0', '@types/cors': '^2.8.17', tsx: '^4.19.0', typescript: '^6.0.3' }
  }
  const tsconfig = {
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      esModuleInterop: true,
      outDir: './dist',
      rootDir: './src',
      strict: true,
      skipLibCheck: true
    },
    include: ['src/**/*.ts']
  }
  const index = `import express from 'express'

const app = express()
app.use(express.json())

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' })
})

const PORT = Number(process.env.PORT ?? 3000)
app.listen(PORT, () => {
  console.log(\`server listening on http://localhost:\${PORT}\`)
})
`
  return [
    { path: 'package.json', content: JSON.stringify(pkg, null, 2) + '\n' },
    { path: 'tsconfig.json', content: JSON.stringify(tsconfig, null, 2) + '\n' },
    { path: 'src/index.ts', content: index }
  ]
}

export const expressSkeletonScaffolder: BaseScaffolder = {
  scaffold (spec, absDir, _opts) {
    if (spec.kind !== 'backend') throw new Error('expressSkeletonScaffolder handles only backend targets')
    writeFiles(files(basename(absDir)), absDir, { force: false })
  }
}
