# BTMS Permission Module Integration

This guide covers the trust boundary, lifecycle, and failure behavior expected
when integrating `@bsv/btms-permission-module` into a wallet.

## Architecture

```text
Untrusted application
  -> WalletPermissionsManager
    -> BasicTokenModule
      -> trusted host prompt
      -> wallet action/signature only after authorization
```

The module receives permission hooks for the `btms` scheme. The host owns the
prompt UI and the wallet owns the action/signature implementation. Applications
must not be able to replace the callback, render over the trusted prompt, or
bypass the permission manager.

## Create and Register the Module

The factory creates a BTMS client for metadata enrichment:

```typescript
import { createBtmsModule } from '@bsv/btms-permission-module'
import { WalletPermissionsManager } from '@bsv/wallet-toolbox-client'

const module = createBtmsModule({
  wallet,
  promptHandler: async (originator, message) => {
    return await trustedPromptController.request({
      originator,
      payload: parseBTMSPrompt(message)
    })
  }
})

const permissionsManager = new WalletPermissionsManager(wallet, adminOriginator, {
  ...permissionConfig,
  permissionModules: {
    ...permissionConfig.permissionModules,
    btms: module
  }
})
```

Direct construction avoids the metadata lookup dependency:

```typescript
import { BasicTokenModule } from '@bsv/btms-permission-module'

const module = new BasicTokenModule((originator, message) =>
  trustedPromptController.request({ originator, payload: parseBTMSPrompt(message) })
)
```

## Parse Prompt Messages Conservatively

Structured spend, burn, and access prompts are JSON. The module may emit a
plain-text fallback when it cannot safely derive token details. A host should
never interpret parse failure as approval:

```typescript
function parseBTMSPrompt(message: string): unknown {
  try {
    return JSON.parse(message)
  } catch {
    return {
      type: 'btms_generic',
      message
    }
  }
}
```

Render every value as untrusted text. The prompt should visibly identify the
requesting originator, action, token, amount, recipient when known, change, and
whether the action burns tokens. Approval must require an explicit user action.
Closing, timing out, navigating away, or encountering a rendering error should
deny.

## Lifecycle

Keep one module instance for the lifetime of its wallet permission manager. The
module holds short-lived, originator-scoped authorization and transaction
commitments in memory.

```typescript
try {
  await runWalletSession({ permissionsManager })
} finally {
  module.dispose()
}
```

`dispose()` clears this sensitive state. Normal expiry is request-driven, so the
module does not create a background interval or keep the process alive.

## Authorization Flow

### Token access

`listActions` requests for BTMS labels and `listOutputs` requests for `p btms`
baskets prompt once per originator session. Denial throws and prevents the
wallet operation.

### Transfer or burn

For `createAction`, the module parses BTMS input BEEF and output scripts. It
rejects mixed asset IDs and invalid burn/send combinations. It prompts with the
details it can verify, or uses the generic prompt if those details cannot be
derived safely.

After approval, the wallet executes `createAction`. The module then derives the
exact SHA-256 signing digest for every input in the returned signable
transaction. Failure to parse that response clears authorization and fails
closed.

For `createSignature`, the module verifies the 32-byte digest supplied by
`PushDrop` against that exact transaction commitment. A full BIP-143 preimage is
also accepted when its SHA-256 digest matches. Truncated, malformed,
substituted, unbound, or expired requests are rejected.

### Issuance

Issuance does not spend an existing BTMS asset, so it can proceed without a
prompt only when the request proves issuance. Accepted markers are:

- an exact `btms_type_issue` output tag; or
- an exact `ISSUE` value in the PushDrop asset field, including a valid
  signature preimage's script code.

An unmarked action, a digest-only signature request, or a malformed preimage is
not treated as issuance and therefore cannot take the automatic path. Unbound
signature approval is one-shot and is not inherited from a token-access grant.

## Failure Handling

The permission module communicates denial and verification failures by throwing.
The host should abort the wallet operation and surface a neutral error that does
not leak sensitive transaction data.

Do not retry a denied prompt automatically. After an expired or invalidated
authorization, restart the intended wallet flow so that a new `createAction`
approval and transaction commitment are established together.

## Integration Checklist

- Route every `p btms ...` permission hook through the same module instance.
- Render prompts in trusted wallet UI and identify the originator.
- Escape all message fields and deny on UI or parsing failure.
- Do not infer approval from session presence outside this module.
- Keep the action response and signature request in the expected hook order.
- Call `dispose()` on logout, wallet replacement, or host shutdown.
- Exercise approval, denial, expiry, malformed transaction, short preimage,
  outpoint substitution, output substitution, issuance, access, transfer, and
  burn paths in host-level tests.
- Run the package's type, lint, coverage, build, and packed-consumer gates.

## Related Documentation

- [Package overview and prompt contract](./README.md)
- [BTMS library](../btms/README.md)
- [BTMS overlay backend](../../overlays/btms-backend/README.md)

## License

Open BSV License version 6. See [LICENSE.txt](./LICENSE.txt).
