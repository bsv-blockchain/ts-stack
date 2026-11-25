# BSV Project

Standard BSV project structure.

Helpful Links:

- [LARS (for local development)](https://github.com/p2ppsr/lars)
- [CARS CLI (for cloud deployment)](https://github.com/p2ppsr/cars-cli)
- [RUN YOUR OWN CARS NODE](https://github.com/bitcoin-sv/cars-node)
- [Specification for deployment-info.json](https://github.com/bitcoin-sv/BRCs/blob/master/apps/0102.md)

## Getting Started

- Install the workspace dependencies from the repository root with
  `pnpm install --frozen-lockfile --ignore-scripts`.
- Run `pnpm --filter @bsv/wui lars` to configure local development and
  `pnpm --filter @bsv/wui start` to start it.

## CARS release

Use the [UI CARS release workflow](../../../.github/workflows/ui-cars-release.yml)
on `main` with project `wui` and target `1`. Leave publication disabled
to build the frontend and retain its archive for review. Publication uses the
approved archive, verifies its SHA-256 digest, and waits for the CARS deployment
result.

## Directory Structure

The project structure is roughly as follows, although it can vary by project.

```
| - deployment-info.json
| - package.json
| - local-data/
| - frontend/
  | - package.json
  | - webpack.config.js
  | - src/...
  | - public/...
  | - build/...
| - backend/
  | - package.json
  | - tsconfig.json
  | - mod.ts
  | - src/
    | - contracts/...
    | - lookup-services/...
    | - topic-managers/...
    | - script-templates/...
  | - artifacts/
  | - dist/
```

The one constant is `deployment-info.json`.

## License

[Apache License 2.0](../../LICENSE)
