# BRC100 UI React Components

A library of reusable React components for building wallet UIs.

## Installation

```bash
npm install @bsv/brc100-ui-react-components
```

The host supplies SDK 4.1.2 or newer within SDK 4, wallet-toolbox client 2.18 or
newer within major 2, and React and React DOM 18. The browser entry works with Vite and esbuild. Node imports and CommonJS consumers share
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
