import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import mdx from '@mdx-js/rollup'
import remarkGfm from 'remark-gfm'
import remarkFrontmatter from 'remark-frontmatter'
import remarkMdxFrontmatter from 'remark-mdx-frontmatter'
import rehypeSlug from 'rehype-slug'
import rehypeAutolinkHeadings from 'rehype-autolink-headings'
import rehypeShiki from '@shikijs/rehype'
import { createReadStream, cpSync, existsSync, statSync } from 'fs'
import { resolve, dirname, extname, join, relative } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BASE = '/ts-stack/'
const DOCS_ROOT = resolve(__dirname, '../docs')
const DOCS_ASSETS = resolve(DOCS_ROOT, 'assets')

const assetMimeTypes: Record<string, string> = {
  '.gif': 'image/gif',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
}

function docsAssetPathFromUrl(url: string | undefined) {
  const pathname = (url ?? '').split('?')[0]
  const assetPath = pathname.startsWith(`${BASE}assets/`)
    ? pathname.slice(BASE.length)
    : pathname.startsWith('/assets/')
      ? pathname.slice(1)
      : null

  if (!assetPath?.match(/^assets\/(?:diagrams|images)\//)) return null
  return decodeURIComponent(assetPath.slice('assets/'.length))
}

function resolveDocsAsset(assetPath: string) {
  const file = resolve(DOCS_ASSETS, assetPath)
  const rel = relative(DOCS_ASSETS, file)
  if (rel.startsWith('..') || rel.startsWith('/')) return null
  return file
}

function docsAssetsPlugin(): import('vite').Plugin {
  return {
    name: 'docs-assets',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const assetPath = docsAssetPathFromUrl(req.url)
        if (!assetPath) return next()

        const file = resolveDocsAsset(assetPath)
        if (!file || !existsSync(file) || !statSync(file).isFile()) return next()

        res.setHeader('Content-Type', assetMimeTypes[extname(file).toLowerCase()] ?? 'application/octet-stream')
        createReadStream(file).pipe(res)
      })
    },
    closeBundle() {
      const distAssets = resolve(__dirname, 'dist/assets')
      for (const folder of ['diagrams', 'images']) {
        const sourceRoot = join(DOCS_ASSETS, folder)
        cpSync(sourceRoot, join(distAssets, folder), {
          recursive: true,
          filter: (source) => !relative(sourceRoot, source).split(/[/\\]/).some((part) => part.startsWith('.')),
        })
      }
    },
  }
}

function isExternalHref(href: string) {
  return /^(?:https?:|data:|mailto:|#|\/\/)/.test(href)
}

function splitUrlSuffix(url: string) {
  const suffixIndex = url.search(/[?#]/)
  if (suffixIndex === -1) return { pathname: url, suffix: '' }
  return {
    pathname: url.slice(0, suffixIndex),
    suffix: url.slice(suffixIndex),
  }
}

function docsRouteFromMarkdownPath(relPath: string) {
  if (relPath === 'index.md') return ''
  if (relPath.endsWith('/index.md')) return relPath.slice(0, -'index.md'.length)
  return `${relPath.slice(0, -'.md'.length)}/`
}

function routeForMarkdownFile(file: string, suffix: string) {
  const relPath = relative(DOCS_ROOT, file).replace(/\\/g, '/')
  if (relPath.startsWith('../') || relPath === '..' || relPath.startsWith('/') || !relPath.endsWith('.md')) {
    return null
  }

  return `${BASE}${docsRouteFromMarkdownPath(relPath)}${suffix}`
}

function resolveDocsHrefPath(pathname: string, sourceFile: string) {
  const normalized = pathname.endsWith('/') ? pathname.slice(0, -1) : pathname
  const targetPath = pathname.startsWith('/docs/')
    ? resolve(DOCS_ROOT, pathname.slice('/docs/'.length))
    : pathname.startsWith('/')
      ? resolve(DOCS_ROOT, pathname.slice(1))
      : resolve(dirname(sourceFile), normalized)

  if (pathname.endsWith('.md')) return targetPath

  if (/\.[a-z0-9]+$/i.test(pathname)) return null

  const directFile = `${targetPath}.md`
  if (existsSync(directFile)) return directFile

  const indexFile = join(targetPath, 'index.md')
  if (existsSync(indexFile)) return indexFile

  return null
}

function sourceFilePath(file: Record<string, unknown> | undefined) {
  if (typeof file?.path === 'string') return file.path
  const history = file?.history
  if (Array.isArray(history)) {
    const last = history[history.length - 1]
    if (typeof last === 'string') return last
  }
  return resolve(DOCS_ROOT, 'index.md')
}

function normalizeDocsPageHref(href: string, sourceFile: string) {
  if (isExternalHref(href)) return href

  const { pathname, suffix } = splitUrlSuffix(href)
  if (!pathname || pathname.startsWith(BASE)) return href

  const targetFile = resolveDocsHrefPath(pathname, sourceFile)
  if (!targetFile) return href

  return routeForMarkdownFile(targetFile, suffix) ?? href
}

function normalizeDocsAssetSrc(src: string) {
  if (isExternalHref(src)) return src

  const match = src.match(/(?:^|\/)(assets\/(?:diagrams|images)\/[^?#]+)/)
  if (!match) return src

  const assetPath = match[1]
  const suffix = src.slice(src.indexOf(assetPath) + assetPath.length)
  return `${BASE}${assetPath}${suffix}`
}

function rehypeDocsPaths() {
  return (tree: Record<string, unknown>, file: Record<string, unknown>) => {
    rewriteDocsPaths(tree, sourceFilePath(file))
  }
}

function rewriteDocsPaths(node: Record<string, unknown>, sourceFile: string) {
  if (node.type === 'element' && node.tagName === 'a') {
    const properties = node.properties as Record<string, unknown> | undefined
    if (properties && typeof properties.href === 'string') {
      properties.href = normalizeDocsPageHref(properties.href, sourceFile)
    }
  }

  if (node.type === 'element' && node.tagName === 'img') {
    const properties = node.properties as Record<string, unknown> | undefined
    if (properties && typeof properties.src === 'string') {
      properties.src = normalizeDocsAssetSrc(properties.src)
    }
  }

  const children = node.children
  if (Array.isArray(children)) {
    for (const child of children) {
      if (child && typeof child === 'object') rewriteDocsPaths(child as Record<string, unknown>, sourceFile)
    }
  }
}

/**
 * Remark plugin: find `html` MDAST nodes that contain known JSX component
 * tags (e.g. `<AsyncApiEmbed slug="brc29" />`) and convert them to a custom
 * MDAST node type. The corresponding remarkRehypeOptions.handlers entry then
 * turns those into proper HAST elements. This sidesteps rehypeRemoveRaw, which
 * MDX adds when processing .md files in format:'md' mode and which silently
 * strips all raw HTML nodes before user rehype plugins can see them.
 */
function remarkLiftHtmlComponents() {
  return (tree: { type: string; children: Array<Record<string, unknown>> }) => {
    liftInChildren(tree.children)
  }
}

function liftInChildren(children: Array<Record<string, unknown>>) {
  for (let i = 0; i < children.length; i++) {
    const node = children[i]
    if (node.type === 'html' && typeof node.value === 'string') {
      const asyncApiMatch = (node.value as string).match(/<AsyncApiEmbed\s+slug="([^"]+)"\s*\/>/)
      if (asyncApiMatch) {
        children[i] = { type: 'asyncApiEmbed', slug: asyncApiMatch[1] }
        continue
      }
      if ((node.value as string).match(/<HomeHero\s*\/>/)) {
        children[i] = { type: 'homeHero' }
        continue
      }
    }
    const childList = node.children
    if (Array.isArray(childList)) liftInChildren(childList as Array<Record<string, unknown>>)
  }
}

const stripAudioComments: import('vite').Plugin = {
  name: 'strip-audio-comments',
  enforce: 'pre',
  transform(code, id) {
    if (!id.endsWith('.md') && !id.endsWith('.mdx')) return
    return { code: code.replace(/<!--\s*audio:[^>]*-->/g, ''), map: null }
  },
}

export default defineConfig({
  base: BASE,
  plugins: [
    stripAudioComments,
    docsAssetsPlugin(),
    {
      enforce: 'pre',
      ...mdx({
        remarkPlugins: [remarkGfm, remarkFrontmatter, remarkMdxFrontmatter, remarkLiftHtmlComponents],
        remarkRehypeOptions: {
          handlers: {
            homeHero: () => ({
              type: 'element',
              tagName: 'div',
              properties: { className: ['bsv-hero'] },
              children: [{
                type: 'element',
                tagName: 'div',
                properties: { className: ['bsv-hero__inner'] },
                children: [
                  {
                    type: 'element',
                    tagName: 'div',
                    properties: { className: ['bsv-hero__title'] },
                    children: [
                      {
                        type: 'element',
                        tagName: 'span',
                        properties: {},
                        children: [{ type: 'text', value: 'BSV' }],
                      },
                      { type: 'text', value: ' application infrastructure in TypeScript' },
                    ],
                  },
                  {
                    type: 'element',
                    tagName: 'p',
                    properties: { className: ['bsv-hero__lede'] },
                    children: [{
                      type: 'text',
                      value: 'Reference packages, protocol specs, infrastructure contracts, and conformance vectors for building wallet-aware BSV applications. Use it as an app developer, a wallet implementer, or the baseline another language implementation must match.',
                    }],
                  },
                  {
                    type: 'element',
                    tagName: 'a',
                    properties: { className: ['bsv-hero__cta'], href: `${BASE}get-started/` },
                    children: [
                      { type: 'text', value: 'Choose your entry point' },
                      {
                        type: 'element',
                        tagName: 'span',
                        properties: { className: ['bsv-hero__cta-arrow'], ariaHidden: 'true' },
                        children: [{ type: 'text', value: '->' }],
                      },
                    ],
                  },
                ],
              }],
            }),
            asyncApiEmbed: (_state: unknown, node: Record<string, unknown>) => ({
              type: 'element',
              tagName: 'iframe',
              properties: {
                src: `${BASE}assets/asyncapi/${node.slug}/index.html`,
                style: 'width: 100%; min-height: 900px; border: none; background: #011627; border-radius: 8px;',
                title: `AsyncAPI Specification (${node.slug})`,
                loading: 'lazy',
              },
              children: [],
            }),
          },
        },
        rehypePlugins: [
          rehypeDocsPaths,
          rehypeSlug,
          [rehypeAutolinkHeadings, { behavior: 'wrap' }],
          [rehypeShiki, {
            theme: 'github-dark-dimmed',
            langs: ['typescript', 'javascript', 'bash', 'json', 'yaml', 'markdown', 'html', 'css', 'sql', 'go', 'rust', 'python'],
            transformers: [{
              pre(node: { properties: Record<string, unknown> }) {
                const lang = (this as { options?: { lang?: string } }).options?.lang
                if (lang) node.properties['data-language'] = lang
              },
            }],
          }],
        ],
        providerImportSource: '@mdx-js/react',
      }),
    },
    react({ include: /\.(jsx|tsx|js|ts)$/ }),
  ],
  resolve: {
    alias: {
      '@docs': resolve(__dirname, '../docs'),
      '@': resolve(__dirname, 'src'),
      '@mdx-js/react': resolve(__dirname, 'node_modules/@mdx-js/react/index.js'),
    },
  },
  server: {
    fs: { allow: ['..', resolve(__dirname, '../docs')] },
  },
  build: {
    outDir: 'dist',
    rollupOptions: {
      external: [/^\/_pagefind\//],
    },
  },
})
