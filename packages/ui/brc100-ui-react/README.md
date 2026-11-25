# BRC100 UI React Components

A library of reusable React components for building wallet UIs.

## Installation

```bash
npm install @bsv/brc100-ui-react-components
```

Use React and React DOM 18 in the host application. Keep the host's SDK and wallet-toolbox client within the
package's peer ranges. The browser entry works with Vite and esbuild. Node imports and CommonJS consumers share
the same React context instances.

```tsx
import { UserInterface } from '@bsv/brc100-ui-react-components'

export function WalletScreen(props: React.ComponentProps<typeof UserInterface>) {
  return <UserInterface {...props} />
}
```

Run `pnpm typecheck`, `pnpm test`, `pnpm pack:check`, and `pnpm test:browser` from this workspace
to exercise the declarations, package entrypoints, and browser builds.

## License

The license for the code in this repository is the Apache License 2.0.

[Apache License 2.0](./LICENSE)
