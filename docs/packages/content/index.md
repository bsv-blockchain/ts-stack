---
id: content-packages
title: Content
kind: meta
domain: content
version: 'n/a'
last_updated: '2026-08-28'
last_verified: '2026-08-28'
review_cadence_days: 30
status: experimental
tags: ['content', 'licensing', 'media']
---

# Content

Content packages bind encrypted media and other creative works to portable
rights, acquisition, key-delivery, provenance, and composition records.

| Package              | Purpose                                                                    |
| -------------------- | -------------------------------------------------------------------------- |
| [@bsv/lch](./lch.md) | Build and consume BRC-170 licensed-content objects and composition records |

Storage remains a separate concern. LCH ciphertext can use ordinary HTTPS,
UHRP, or CHIRP without changing those protocols.

Start with the [production CHIRP and LCH guide](../../guides/chirp-lch-production.md)
for end-to-end creator, buyer, Payee, wallet, storage, recovery, and deployment
architecture.
