import { isAbsolute, relative, resolve, sep } from 'node:path'

export const SITE_BASE = '/ts-stack/'

export function isExternalUrl(value) {
  return /^(?:https?:|data:|mailto:|#|\/\/)/.test(value)
}

export function splitUrl(value) {
  const suffixIndex = value.search(/[?#]/)
  if (suffixIndex === -1) return { pathname: value, suffix: '' }
  return {
    pathname: value.slice(0, suffixIndex),
    suffix: value.slice(suffixIndex)
  }
}

export function assetPathForBuiltUrl(pathname, base = SITE_BASE) {
  if (pathname.startsWith(base)) return pathname.slice(base.length)
  if (pathname.startsWith('/assets/')) return pathname.slice(1)
  return null
}

export function resolveInsideRoot(root, localPath) {
  let decodedPath
  try {
    decodedPath = decodeURIComponent(localPath)
  } catch {
    return null
  }

  const fullPath = resolve(root, decodedPath)
  const rel = relative(root, fullPath)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null
  return fullPath
}

export function routeOutput(root, routePath) {
  if (!/^\/[A-Za-z0-9/_-]*$/.test(routePath) || routePath.split('/').includes('..')) {
    throw new Error(`Unsafe static route path: ${routePath}`)
  }

  const relativeRoute = routePath.slice(1).replace(/\/$/, '')
  const localPath = relativeRoute ? `${relativeRoute}/index.html` : 'index.html'
  const outputPath = resolveInsideRoot(root, localPath)
  if (outputPath === null) {
    throw new Error(`Static output escapes dist: ${routePath}`)
  }
  return outputPath
}
