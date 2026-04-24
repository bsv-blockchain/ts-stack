# BSV Paymail

## Table of Contents

- [BSV Paymail](#bsv-paymail)
  - [Table of Contents](#table-of-contents)
  - [Objective](#objective)
  - [Getting Started](#getting-started)
    - [npm install](#npm-install)
    - [Basic Usage](#basic-usage)
      - [Paymail Server](#paymail-server)
      - [Paymail Client](#paymail-client)
  - [Documentation](#documentation)
  - [Contribution Guidelines](#contribution-guidelines)
  - [Support \& Contacts](#support--contacts)
  - [License](#license)

## Objective

The objective of this project is to develop a robust and versatile TypeScript library for Bitcoin SV (BSV) Paymail, aimed at enhancing the integration and functionality of Paymail in the BSV blockchain ecosystem. This library will focus on two primary components:

1. **Server Development**: Building a comprehensive server setup that supports service discovery and a variety of capabilities. It will include default functionalities like P2P Destinations, Receive Raw Transaction, Public Profile, and the flexibility for developers to incorporate additional custom capabilities.

2. **Client Implementation**: Creating client-side features to facilitate host and capability discovery in both Node.js and browser environments. This will involve developing methods for seamless interaction with the server's provided capabilities.

The project aims to streamline the process of integrating BSV Paymail into various applications, promoting broader adoption and utility within the BSV ecosystem.


## Getting Started

### npm install


```bash
npm install @bsv/paymail
```

### Basic Usage

#### Paymail Server
```typescript
import express from 'express'
import { PaymailRouter, PublicKeyInfrastructureRoute, PublicProfileRoute } from '@bsv/paymail'

const app = express()
const baseUrl = 'https://myDomain.com'

const publicProfileRoute = new PublicProfileRoute({
  domainLogicHandler: async (name, domain) => {
    const user = await fetchUser(name, domain)
    return {
      name: user.getAlias(),
      domain,
      avatar: user.getAvatarUrl()
    }
  }
})

const pkiRoute = new PublicKeyInfrastructureRoute({
  domainLogicHandler: async (name, domain) => {
    const user = await fetchUser(name, domain)
    return {
      bsvalias: '1.0',
      handle: `${name}@${domain}`,
      pubkey: user.getIdentityKey()
    }
  }
})

const routes = [publicProfileRoute, pkiRoute]
const paymailRouter = new PaymailRouter({ baseUrl, routes })
app.use(paymailRouter.getRouter())

const PORT = 3000
app.listen(PORT, async () => {
  console.log(`Server is running on ${baseUrl}:${PORT}`)
})
```

#### Paymail Client

```typescript
import { PaymailClient } from '@bsv/paymail'

const client = new PaymailClient();

(async () => {
  const publicProfile = await client.getPublicProfile('satoshi@myDomain.com')
  console.log(publicProfile)
})()

```

For a more detailed tutorial and advanced examples, check our [Documentation](#documentation).


## Documentation

The SDK is richly documented with code-level annotations. This should show up well within editors like VSCode. For complete API docs, check out [the docs folder](./docs)

## Contribution Guidelines

We're always looking for contributors to help us improve the project. Whether it's bug reports, feature requests, or pull requests - all contributions are welcome.

1. **Fork & Clone**: Fork this repository and clone it to your local machine.
2. **Set Up**: Run `npm install` to install all dependencies.
3. **Make Changes**: Create a new branch and make your changes.
4. **Test**: Ensure all tests pass by running `npm test`.
5. **Commit**: Commit your changes and push to your fork.
6. **Pull Request**: Open a pull request from your fork to this repository.

For more details, check the [contribution guidelines](./CONTRIBUTING.md).

For information on past releases, check out the [changelog](./CHANGELOG.md). For future plans, check the [roadmap](./ROADMAP.md)!

## Support & Contacts
Project Owners: Thomas Giacomo and Darren Kellenschwiler

Development Team Lead: Brandon Bryant

For questions, bug reports, or feature requests, please open an issue on GitHub or contact us directly.

## License

The license for the code in this repository is the Open BSV License. Refer to [LICENSE.txt](./LICENSE.txt) for the license text.

Thank you for being a part of the BSV Blockchain ecosystem. Let's build the future of BSV Blockchain together!
