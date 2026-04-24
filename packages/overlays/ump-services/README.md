# BSV Project

Standard BSV project structure.

Helpful Links:

- [LARS (for local development)](https://github.com/bitcoin-sv/lars)
- [CARS CLI (for cloud deployment)](https://github.com/bitcoin-sv/cars-cli)
- [RUN YOUR OWN CARS NODE](https://github.com/bitcoin-sv/cars-node)
- [Specification for deployment-info.json](https://github.com/bitcoin-sv/BRCs/blob/master/apps/0102.md)

## Getting Started

- Clone this repository
- Run `npm i` to install dependencies
- Run `npm run lars` to configure the local environment according to your needs
- Use `npm run start` to spin up and start writing code
- When you're ready to publish your project, start by running `npm run cars` and configuring one (or, especially for overlays, ideally multiple) hosting provider(s)
- For each of your configurations, execute `npm run build` to create CARS project artifacts
- Deploy with `npm run deploy` and your project will be online
- Use `cars` interactively, or visit your hosting provider(s) web portals, to view logs, configure custom domains, and pay your hosting bills
- Share your new BSV project, it is now online!

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

[Open BSV License](./LICENSE.txt)
