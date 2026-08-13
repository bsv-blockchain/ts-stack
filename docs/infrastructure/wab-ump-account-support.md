---
id: wab-ump-account-support
title: 'WAB UMP Account Support'
kind: runbook
version: '1.0.0'
last_updated: '2026-08-13'
last_verified: '2026-08-13'
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

## Prerequisites

- The UMP overlay runs the reservation-aware topic manager and lookup service.
- The WAB migration containing `umpTokenOutpoint`, `phone_change_sessions`, and
  `phone_change_history` has completed.
- `WAB_ADMIN_TOKEN` is at least 32 random characters and comes from the
  deployment secret manager. If it is absent, `/admin/*` intentionally returns 404.
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

5. Ask the user to retry ordinary sign-in. The client first attempts normal
   verified lineage resolution. It applies the pin only if ambiguity remains
   and the pinned outpoint is in its verified candidate set.
6. Record the ticket ID, redacted account identifier, selected outpoint, WAB
   deployment version, operator, and validation result.

Clear a pin after the account has a single healthy current UMP token:

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

An incorrect or stale pin does not authorize an unknown token; the client
ignores it and keeps reporting ambiguity.

## Phone-number changes and takeovers

The wallet must already be authenticated. It sends the current presentation
key to WAB, proves possession of the requested number through Twilio OTP, then
publishes a new UMP token that spends the current token. The final WAB commit:

- accepts the existing phone number as a deliberate key/hash refresh;
- permits a verified number to move from another live WAB user;
- rotates the target WAB presentation key and clears its previous UMP pin;
- detaches the target's prior phone association when the number differs; and
- records both prior associations and the returned `changeId`.

The authorization token is hashed at rest, expires after ten minutes, and is
single-use. Retrying a lost final response is idempotent when the same new
presentation key is supplied.

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
2. deploy the reservation-aware UMP overlay and validate duplicate rejection;
3. apply the WAB additive migration and deploy WAB with its admin secret;
4. publish/deploy Wallet Toolbox clients; and
5. enable desktop/mobile phone-change UI.

Validate an ordinary existing login, a clean new account, an ambiguity login
with a valid pin, rejection of a pin absent from candidates, same-number
rotation, different-number rotation, takeover, and restore in a non-production
environment before production enablement.

The previous overlay and WAB binaries ignore the additive reservation and
history data, so an image rollback can retain both schemas. Do not run the WAB
down migration after any phone change, because it destroys automatic restore
history. Disable phone-change UI first if WAB must roll back. Retain the UMP
reservation collection unless a reviewed database recovery plan explicitly
reconstructs ownership.
