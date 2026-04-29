import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import mdx from '@mdx-js/rollup'
import remarkGfm from 'remark-gfm'
import remarkFrontmatter from 'remark-frontmatter'
import remarkMdxFrontmatter from 'remark-mdx-frontmatter'
import rehypeSlug from 'rehype-slug'
import rehypeAutolinkHeadings from 'rehype-autolink-headings'
import rehypeShiki from '@shikijs/rehype'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

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

const BASE = '/ts-stack/'

export default defineConfig({
  base: BASE,
  plugins: [
    stripAudioComments,
    {
      enforce: 'pre',
      ...mdx({
        remarkPlugins: [remarkGfm, remarkFrontmatter, remarkMdxFrontmatter, remarkLiftHtmlComponents],
        remarkRehypeOptions: {
          handlers: {
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
