# ts-stack documentation site

This private Vite/React workspace builds the documentation published from the
repository's `docs/` content. It is not an npm package.

From the repository root:

```sh
pnpm --filter docs-site dev
pnpm --filter docs-site format:check
pnpm --filter docs-site lint
pnpm --filter docs-site test
pnpm --filter docs-site typecheck
pnpm --filter docs-site validate
pnpm --filter docs-site build
```

`test` covers the path and URL policy used by prerendering and built-link
validation. `typecheck` regenerates the content manifest before checking the
application. `validate` checks frontmatter and source links. `build` generates
the manifest, builds the browser and server-rendered applications, prerenders
every route, copies owned documentation assets, builds search data, and checks
the final site's links.

Package versions, runtime support, conformance facts, and release instructions
should come from repository-owned manifests and generated data rather than
being duplicated manually in this application.

The Mermaid 12 dependency graph resolves DOMPurify 3.4.17, which fixes the
upstream shadow-root template and detached-node sanitization advisories.
This compatible lockfile refresh also updates Mermaid's parser, diagram layout,
UUID and package-detection dependencies within their existing declared ranges.
It changes no Mermaid configuration or wallet dependency. The governed bundle
inventory tracks the actual client components and their license hashes; the
ordinary site build verifies that inventory and generates deployment notices.
