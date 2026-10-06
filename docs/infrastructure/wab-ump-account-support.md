---
id: wab-ump-account-support
title: 'WAB UMP Account Support'
kind: infra
version: '1.2.0'
last_updated: '2026-10-05'
last_verified: '2026-10-05'
review_cadence_days: 30
status: stable
tags: [wab, ump, support, phone, recovery]
---

# WAB UMP Account Support

Use this runbook for a wallet that sees more than one verified UMP token for a
presentation or recovery hash, or for a disputed phone-number transfer. Never
pin an outpoint merely because a requester supplies it. Preserve the ticket,
the candidate set, the operator identity, and the final action without copying
presentation keys, OTPs, admin tokens, or full phone numbers into broad logs.

## Recover an interrupted account creation

Current WAB registrations are created as pending and become active only after
the wallet publishes its UMP token. Updated clients resume a pending account
when verified lookup returns a clean empty result, or finalize it when the UMP
token is already visible. They never treat an active or legacy account as new.

Accounts stranded before the registration-state migration are deliberately
backfilled active. Reopen one only after support has independently verified the
requester. The WAB support route performs its own verified `ls_users` lookup for
the stored presentation hash and reopens the registration only when that lookup
is cleanly empty. A timeout, incomplete host set, malformed answer, ambiguity,
or published token fails closed and leaves the registration active.

```bash
curl --fail-with-body --request POST "${WAB_SUPPORT_URL}/admin/registration/reopen" \
  --header "Authorization: Bearer ${WAB_ADMIN_TOKEN}" \
  --header 'Content-Type: application/json' \
  --data '{
    "methodType": "TwilioPhone",
    "payload": { "phoneNumber": "+12065550100" }
  }'
```

Before repeating account creation, inspect the existing wallet's faucet action.
An empty wallet on an older SDK may reject a legitimate storage service charge
with `Wallet used a requested input to fund an unrequested output`. The toolbox
2.14.6 source fix requires an SDK exposing
`completeBoundAction.outputAuthorizationVersion=1`; it preserves exact output
binding and does not increase the faucet grant or remove storage fees.

This fix does not repair signup checkpoints. Internalization clears recovery
custom instructions, while `listActions` does not return them. A retry after
partial funding or UMP publication may require reconciliation of the original
wallet and transaction; retain the root key and wallet records before retrying.
Do not infer that the absence of a UMP token means the wallet has no funds.

After reconciling funding, repeat ordinary phone verification and account creation. The
WAB reuses the original presentation key, preserves faucet history, and returns
to active after publication. Record the ticket, operator, redacted identity,
lookup evidence, WAB version, and successful final state. Never delete the auth
method as a shortcut: deletion can lose ownership evidence and does not prove
that the UMP side is empty.

## Prerequisites

- The UMP overlay runs the reservation-aware topic manager and lookup service.
- The WAB migration containing `umpTokenOutpoint`, `phone_change_sessions`, and
  `phone_change_history` has completed.
- `WAB_ADMIN_TOKEN` is at least 32 random characters and comes from the
  deployment secret manager. If it is absent, `/admin/*` intentionally returns
  404; if it is non-empty but shorter, WAB refuses to start.
- The support workstation reaches WAB only over the trusted HTTPS endpoint.

## Pin an ambiguous UMP account

1. Verify the support requester through the approved account-support process.
2. Obtain the presentation/recovery hash and candidate outpoints from the
   wallet's redacted diagnostics. These values are not wallet keys.
3. Query `ls_users` by that hash and confirm every candidate independently.
   Inspect the referenced output and lineage. Select only an outpoint returned
   by the overlay and owned by the supported account.
4. Set the pin by canonical phone identity (or by presentation key inside the
   restricted operator environment):

   ```bash
   curl --fail-with-body --request POST "${WAB_SUPPORT_URL}/admin/ump-pin" \
     --header "Authorization: Bearer ${WAB_ADMIN_TOKEN}" \
     --header 'Content-Type: application/json' \
     --data '{
       "methodType": "TwilioPhone",
       "payload": { "phoneNumber": "+12065550100" },
       "outpoint": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.0"
     }'
   ```

5. Ask the user to retry ordinary sign-in. Compatible clients use a verified
   pin as a lineage anchor among competing records. A password or token update
   that consumes that anchor takes precedence, including when the pin is only
   present in authenticated token ancestry. Every token spend proves control,
   including confirmed updates and hash rotation; funding inputs do not establish
   token lineage. An unrelated historical
   continuation cannot override it. Older clients use the pin only as a fallback
   after normal lineage resolution, so validate their actual returned state.
6. Record the ticket ID, redacted account identifier, selected outpoint, WAB
   deployment version, operator, and validation result.

Clear a pin only after ordinary unpinned lookup independently returns the verified current token. Repeat the lookup after clearing; do not clear a pin that still prevents ambiguity or stale selection:

```bash
curl --fail-with-body --request POST "${WAB_SUPPORT_URL}/admin/ump-pin" \
  --header "Authorization: Bearer ${WAB_ADMIN_TOKEN}" \
  --header 'Content-Type: application/json' \
  --data '{
    "methodType": "TwilioPhone",
    "payload": { "phoneNumber": "+12065550100" },
    "outpoint": null
  }'
```

A pin cannot authorize an unknown token. A spent pin may be superseded only by
verified update lineage; it cannot resolve competing descendants. Keep retry and
recovery errors for incomplete, unavailable or unverifiable lookup evidence.

UMP lookup must request the retained token lineage through its overlay history
decider. Deploy `@bsv/overlay@2.6.4` and `@bsv/overlay-topics@2.0.1` (or the
equivalent decider in a custom UMP service) together with Wallet Toolbox 2.14.6.
The engine preserves selected history past confirmed Merkle anchors, and the
client links that history before selecting a current token. The stored pin can
remain an older lineage anchor while password/token updates supersede it.
No additional WAB pin rewrite or schema is required.

Older hosts may omit this history. If an absent old pin is named by an input but
its authenticated source is missing, clients require history rather than selecting
an unrelated historical continuation. Preserve retry/recovery behavior until the
host is corrected; do not make incomplete evidence authoritative.

## Phone-number changes and takeovers

The wallet must already be authenticated. It sends the current presentation
key to WAB and proves possession of the requested number through Twilio OTP.
WAB commit then stages the association and replacement key while retaining the
current key. The wallet publishes a new UMP token that spends the current token
and calls WAB finalize. The staged commit:

- accepts the existing phone number as a deliberate key/hash refresh;
- permits a verified number to move from another live WAB user;
- records the pending target presentation key without removing the current key;
- detaches the target's prior phone association when the number differs; and
- records both prior associations and the returned `changeId`.

Finalize promotes the pending key and clears the previous UMP pin. The
authorization token is hashed at rest, expires after ten minutes, and is
single-use. Retrying commit, UMP publication, or finalize is idempotent for the
same change. If the app restarts between phases, verified authentication
returns both current and pending keys. The wallet uses whichever key is backed
by the verified UMP token and finalizes when the pending key is live. If the
current key is still live, repeating OTP verification returns the already
staged key and change ID so the wallet can resume without a second commit.

## Restore a disputed phone transfer

1. Freeze further automated support changes for the disputed identities.
2. Verify the incident through a second support channel. Do not rely on the
   disputed phone alone.
3. In a read-only database session, locate the most recent unrestored
   `phone_change_history.id` for the canonical number and verify its target,
   prior owner, replacement method, timestamp, and ticket evidence.
4. Restore that exact record:

   ```bash
   curl --fail-with-body --request POST "${WAB_SUPPORT_URL}/admin/phone-change/restore" \
     --header "Authorization: Bearer ${WAB_ADMIN_TOKEN}" \
     --header 'Content-Type: application/json' \
     --data '{ "changeId": 1234 }'
   ```

5. Confirm the claimed phone is again linked to the prior owner and the target's
   replaced phone is linked to the target. The restore refuses to proceed if a
   later ownership change makes either update unsafe; escalate that state for
   manual database recovery from the encrypted backup.
6. The target's on-chain UMP update is not reversed. Determine whether the
   target needs a WAB pin, account recovery, or another verified phone change.

## Rollout and rollback

Roll out in this order:

1. back up MongoDB and the WAB database;
2. publish `@bsv/overlay-topics` 1.7.0 through the protected package workflow
   and merge its generated infrastructure dependency-sync PR;
3. release and deploy the reservation-aware UMP overlay, then validate
   duplicate rejection;
4. apply the WAB additive migrations and deploy WAB with its admin secret;
5. publish/deploy Wallet Toolbox clients; and
6. enable desktop/mobile phone-change UI.

Validate an ordinary existing login, a clean new account, an ambiguity login
with a valid pin, rejection of a pin absent from candidates, same-number
rotation, different-number rotation, takeover, and restore in a non-production
environment before production enablement. Also interrupt a new registration
before UMP publication and after publication but before WAB finalization; both
must resume without changing the stored presentation key.

The previous overlay and WAB binaries ignore the additive reservation and
history data, so an image rollback can retain both schemas. Do not run the WAB
down migration after any phone change, because it destroys automatic restore
history. Disable phone-change UI first if WAB must roll back. Retain the UMP
reservation collection unless a reviewed database recovery plan explicitly
reconstructs ownership.
