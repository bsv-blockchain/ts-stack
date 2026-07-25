#!/usr/bin/env node
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const siteRoot = resolve(scriptDirectory, '..')
const distRoot = resolve(siteRoot, 'dist')
const serverRoot = resolve(siteRoot, '.ssr')
const serverEntry = resolve(serverRoot, 'entry-server.js')
const rootPlaceholder = '<div id="root"></div>'

function routeOutput(routePath) {
  if (!/^\/[A-Za-z0-9/_-]*$/.test(routePath) || routePath.split('/').includes('..')) {
    throw new Error(`Unsafe static route path: ${routePath}`)
  }

  const relativeRoute = routePath === '/'
    ? ''
    : routePath.slice(1, routePath.endsWith('/') ? -1 : undefined)
  return relativeRoute ? resolve(distRoot, relativeRoute, 'index.html') : resolve(distRoot, 'index.html')
}

function assertInsideDist(outputPath) {
  const rel = relative(distRoot, outputPath)
  if (rel.startsWith('..') || rel.startsWith('/')) {
    throw new Error(`Static output escapes dist: ${outputPath}`)
  }
}

try {
  const template = await readFile(resolve(distRoot, 'index.html'), 'utf8')
  if (!template.includes(rootPlaceholder)) {
    throw new Error(`Client template does not contain ${rootPlaceholder}`)
  }

  const { basePath, render, staticPaths } = await import(pathToFileURL(serverEntry).href)
  const normalizedBase = basePath.endsWith('/') ? basePath.slice(0, -1) : basePath
  const routePaths = [...new Set(staticPaths)].sort((left, right) => left.localeCompare(right))

  for (const routePath of routePaths) {
    const outputPath = routeOutput(routePath)
    assertInsideDist(outputPath)
    const markup = await render(`${normalizedBase}${routePath}`)
    const html = template.replace(
      rootPlaceholder,
      `<div id="root" data-prerendered="true" data-route="${routePath}">${markup}</div>`,
    )
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, html)
  }

  const notFoundMarkup = await render(`${normalizedBase}/__not-found__`)
  const notFoundHtml = template.replace(
    rootPlaceholder,
    `<div id="root" data-prerendered="true" data-route="*">${notFoundMarkup}</div>`,
  )
  await writeFile(resolve(distRoot, '404.html'), notFoundHtml)

  console.log(`Pre-rendered ${routePaths.length} documentation routes and 404.html`)
} finally {
  await rm(serverRoot, { recursive: true, force: true })
}
