import fs from 'node:fs'
import path from 'node:path'

export const CDN_ROOT = path.resolve(process.cwd(), 'public/cdn')
export const MAX_OBJECT_ID_LENGTH = 128

const BASE58_OBJECT_ID = /^[1-9A-HJ-NP-Za-km-z]+$/

export function resolveCdnObjectPath(
  objectID: unknown,
  root: string = CDN_ROOT
): string | null {
  if (
    typeof objectID !== 'string' ||
    objectID.length === 0 ||
    objectID.length > MAX_OBJECT_ID_LENGTH ||
    !BASE58_OBJECT_ID.test(objectID)
  ) {
    return null
  }

  const resolvedRoot = path.resolve(root)
  const candidate = path.resolve(resolvedRoot, objectID)
  const rootPrefix = resolvedRoot.endsWith(path.sep)
    ? resolvedRoot
    : `${resolvedRoot}${path.sep}`
  return candidate.startsWith(rootPrefix) && path.dirname(candidate) === resolvedRoot
    ? candidate
    : null
}

export function writeCdnObjectExclusive(
  objectID: unknown,
  data: Uint8Array,
  root: string = CDN_ROOT
): 'stored' | 'exists' | 'invalid' {
  const filePath = resolveCdnObjectPath(objectID, root)
  if (filePath === null) return 'invalid'

  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  try {
    fs.writeFileSync(filePath, data, { flag: 'wx' })
    return 'stored'
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return 'exists'
    throw error
  }
}
