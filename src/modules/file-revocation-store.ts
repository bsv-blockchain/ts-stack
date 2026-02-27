import { RevocationRecord, RevocationStore } from '../core/types'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const nodePath = require('path') as typeof import('path')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const nodeFs = require('fs') as typeof import('fs')

// ============================================================================
// FileRevocationStore (Node.js server only — not browser-safe)
// ============================================================================

export class FileRevocationStore implements RevocationStore {
  private readonly filePath: string
  private mutex: Promise<void> = Promise.resolve()

  constructor (filePath?: string) {
    this.filePath = filePath ?? nodePath.join(process.cwd(), '.revocation-secrets.json')
  }

  private loadAll (): Record<string, RevocationRecord> {
    try {
      if (nodeFs.existsSync(this.filePath)) {
        return JSON.parse(nodeFs.readFileSync(this.filePath, 'utf-8')) as Record<string, RevocationRecord>
      }
    } catch {}
    return {}
  }

  private saveAll (records: Record<string, RevocationRecord>): void {
    nodeFs.writeFileSync(this.filePath, JSON.stringify(records, null, 2))
  }

  private async withLock<T>(fn: (records: Record<string, RevocationRecord>) => T): Promise<T> {
    const prev = this.mutex
    let resolveFunc: (() => void) | undefined
    this.mutex = new Promise<void>(resolve => { resolveFunc = resolve })
    await prev
    try {
      const records = this.loadAll()
      const result = fn(records)
      this.saveAll(records)
      return result
    } finally {
      if (resolveFunc != null) resolveFunc()
    }
  }

  async save (serialNumber: string, record: RevocationRecord): Promise<void> {
    await this.withLock(records => {
      records[serialNumber] = record
    })
  }

  async load (serialNumber: string): Promise<RevocationRecord | undefined> {
    const records = this.loadAll()
    return records[serialNumber]
  }

  async delete (serialNumber: string): Promise<void> {
    await this.withLock(records => {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete records[serialNumber]
    })
  }

  async has (serialNumber: string): Promise<boolean> {
    const records = this.loadAll()
    return serialNumber in records
  }

  async findByOutpoint (outpoint: string): Promise<boolean> {
    const records = this.loadAll()
    return Object.values(records).some(r => r.outpoint === outpoint)
  }
}
