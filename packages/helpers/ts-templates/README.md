# BSV Script Templates

BSV BLOCKCHAIN | Script Templates

A collection of script templates for use with the official BSV TypeScript SDK

## Overview

The goal of this repository is to provide a place where developers from around the ecosystem can publish all manner of script templates, without needing to update the core library. We're generally neutral and unbiased about what people contribute, so feel free to contribute and see what people do with your cool idea!

## Using

You can write code like this:

```ts
import { Transaction } from '@bsv/sdk'
import { OpReturn } from '@bsv/templates'

// Then, just use your template with the SDK!
const instance = new OpReturn()
const tx = new Transaction()
tx.addOutput({
  lockingScript: OpReturn.lock(...),
  satoshis: ...
})
```

## Current Templates

Name                            | Description
--------------------------------|--------------------------
[OpReturn](./src/OpReturn.ts)   | Tag data in a non-spendable script
[Metant](./src/Metanet.ts)      | Create transactions that follow the Metanet protocol
[MultiPushDrop](./src/MultiPushDrop.ts)      | Create data tokens with multiple trusted owners

## Contribution Guidelines

We're always looking for contributors to add the coolest new templates. Whatever kinds of scripts you come up with - all contributions are welcome.

1. **Fork & Clone**: Fork this repository and clone it to your local machine.
2. **Set Up**: Run `npm i` to install all dependencies.
3. **Make Changes**: Create a new branch and make your changes.
4. **Test**: Ensure all tests pass by running `npm test`.
5. **Commit**: Commit your changes and push to your fork.
6. **Pull Request**: Open a pull request from your fork to this repository.
For more details, check the [contribution guidelines](./CONTRIBUTING.md).

For information on past releases, check out the [changelog](./CHANGELOG.md). For future plans, check the [roadmap](./ROADMAP.md)!

## Support & Contacts

Project Owners: Ty Everett

Development Team Lead: Ty Everett

For questions, bug reports, or feature requests, please open an issue on GitHub or contact us directly.

## License

The license for the code in this repository is the Open BSV License. Refer to [LICENSE.txt](./LICENSE.txt) for the license text.

Thank you for being a part of the BSV Blockchain Script Templates Project. Let's build the future of BSV Blockchain together!
