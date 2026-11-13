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

The locked Mermaid 12 client uses DOMPurify 3.4.17 for the published shadow-root
template and detached-node sanitization fixes. Its existing compatible diagram
children and their license hashes are verified against the actual built bundle.
Frontmatter compilation uses remark-mdx-frontmatter 6 with smol-toml instead of
the vulnerable toml package; the obsolete TOML override and exception are removed.
YAML/TOML metadata, named/default exports, explicit parser overrides and malformed
TOML rejection are covered by owning compatibility fixtures. There is no author
configuration migration and no deployed application/runtime dependency change.
