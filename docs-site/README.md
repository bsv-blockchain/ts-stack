# ts-stack documentation site

This private Vite/React workspace builds the documentation published from the
repository's `docs/` content. It is not an npm package.

From the repository root:

```sh
pnpm --filter docs-site dev
pnpm --filter docs-site validate
pnpm --filter docs-site build
```

`validate` checks frontmatter and source links. `build` generates the manifest,
builds the browser and server-rendered applications, prerenders every route,
copies owned documentation assets, builds search data, and checks the final
site's links.

Package versions, runtime support, conformance facts, and release instructions
should come from repository-owned manifests and generated data rather than
being duplicated manually in this application.
