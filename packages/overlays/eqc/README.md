# @bsv/eqc

Economic Query Client for [BRC-178](https://bsv.brc.dev/overlays/0178) race-settled collection
markets. Independent overlay nodes and message box servers answer the same query; the client
ranks them by the time their answers arrive and pays the fastest hosts that agree on the answer.

## Install

```bash
npm install @bsv/eqc @bsv/sdk
```

## Usage

```ts
import { EQC } from '@bsv/eqc'

const eqc = new EQC(wallet)
const answer = await eqc.lookup({ service: 'ls_example', query: { key: 'value' } })
```

Hosts add the market routes with `@bsv/eqc/host`:

```ts
import { createEconomicQueryHost, overlayLookupProvider } from '@bsv/eqc/host'

createEconomicQueryHost({ wallet, providers: [overlayLookupProvider({ engine })] }).mount(router)
```

## License

Open BSV License — see [LICENSE.txt](./LICENSE.txt).
