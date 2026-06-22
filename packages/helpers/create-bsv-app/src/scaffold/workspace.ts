// src/scaffold/workspace.ts
import type { FileSpec } from '../types.js'
import type { PackageManager } from '../config/model.js'

export function workspaceFiles (name: string, pm: PackageManager): FileSpec[] {
  if (pm === 'pnpm') {
    return [
      { path: 'package.json', content: JSON.stringify({ name, private: true }, null, 2) + '\n' },
      { path: 'pnpm-workspace.yaml', content: "packages:\n  - 'client'\n  - 'server'\n" }
    ]
  }
  return [
    { path: 'package.json', content: JSON.stringify({ name, private: true, workspaces: ['client', 'server'] }, null, 2) + '\n' }
  ]
}
