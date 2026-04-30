# Docs Code Block Audit

Generated from fenced code blocks under `docs/`. Total blocks: 312.

Status key: ✅ = checked against local source/package docs/tests and patched if needed.


## docs/about/contributing.md

- ✅ CB-0001 (bash) [30-33] 1. Clone the Repository — `git clone https://github.com/bsv-blockchain/ts-stack`
- ✅ CB-0002 (bash) [37-39] 2. Install Dependencies — `pnpm install`
- ✅ CB-0003 (plain) [45-52] 3. Explore the Structure — `ts-stack/`
- ✅ CB-0004 (bash) [58-60] Create a Feature Branch — `git checkout -b feature/your-feature-name`
- ✅ CB-0005 (typescript) [81-92] Make Changes — `/**`
- ✅ CB-0006 (bash) [96-108] Run Tests — `# Unit tests`
- ✅ CB-0007 (bash) [112-118] Lint Code — `# Check linting`
- ✅ CB-0008 (bash) [124-130] Build Packages — `# Build all packages`
- ✅ CB-0009 (bash) [138-155] Adding Conformance Vectors — `# Create vector file`
- ✅ CB-0010 (bash) [161-163] 1. Push Your Branch — `git push origin feature/your-feature-name`
- ✅ CB-0011 (markdown) [176-198] 2. Create PR on GitHub — `## Description`
- ✅ CB-0012 (typescript) [208-215] Imports — `// Good — import specific exports from the top-level or subpath`
- ✅ CB-0013 (typescript) [219-231] Naming — `// Good`
- ✅ CB-0014 (typescript) [235-246] Error Handling — `// Good`
- ✅ CB-0015 (bash) [258-262] Testing Requirements — `pnpm test`
- ✅ CB-0016 (markdown) [276-294] Reporting Issues — `## Bug Report`
- ✅ CB-0017 (plain) [314-319] Commit Message Format — `type(scope): subject`
- ✅ CB-0018 (plain) [333-338] Commit Message Format — `feat(brc100): add getBalance method`

## docs/about/doc-agent.md

- ✅ CB-0019 (yaml) [21-33] Frontmatter Schema — `---`
- ✅ CB-0020 (yaml) [69-78] Version Management — `# For package docs`
- ✅ CB-0021 (bash) [84-93] Version Checking — `# Check workspace cross-package versions`
- ✅ CB-0022 (yaml) [99-101] Review Cadence — `review_cadence_days: 30  # Review monthly`
- ✅ CB-0023 (plain) [114-116] Staleness Calculation — `stale_date = last_verified + review_cadence_days`
- ✅ CB-0024 (plain) [119-123] Staleness Calculation — `last_verified: "2026-04-28"`
- ✅ CB-0025 (bash) [133-136] Update Package Version — `pnpm sync-versions`
- ✅ CB-0026 (bash) [144-150] Verify Documentation — `pnpm --filter docs-site validate`
- ✅ CB-0027 (bash) [162-167] Extract API Docs — `pnpm --filter @bsv/sdk doc`
- ✅ CB-0028 (yaml) [184-193] GitHub Actions — `- name: Check doc staleness`
- ✅ CB-0029 (markdown) [207-223] Edit a Doc Page — `---`
- ✅ CB-0030 (markdown) [235-251] Create a New Page — `---`
- ✅ CB-0031 (bash) [257-263] Frontmatter Validation — `# Validate frontmatter and relative links`
- ✅ CB-0032 (yaml) [276-288] Spec Page — `---`
- ✅ CB-0033 (yaml) [292-304] Package Page — `---`
- ✅ CB-0034 (yaml) [308-320] Guide Page — `---`

## docs/about/versioning.md

- ✅ CB-0035 (plain) [19-23] Version Format — `MAJOR.MINOR.PATCH`
- ✅ CB-0036 (plain) [34-38] Stable Packages (status: stable) — `@bsv/sdk@1.2.3`
- ✅ CB-0037 (plain) [46-49] Beta Packages (status: beta) — `@bsv/wab-server@0.2.1`
- ✅ CB-0038 (plain) [64-69] Support Windows — `@bsv/sdk@1.x.x — Supported (bug fixes)`
- ✅ CB-0039 (yaml) [77-84] Documentation Versioning — `---`
- ✅ CB-0040 (plain) [97-102] Staleness — `last_verified: "2026-04-28"`
- ✅ CB-0041 (json) [126-133] Dependencies — `{`
- ✅ CB-0042 (bash) [150-153] Publishing — `npm install @bsv/sdk@latest     # Stable`
- ✅ CB-0043 (plain) [165-176] Changelog — `## [1.2.0] - 2026-04-28`

## docs/architecture/beef.md

- ✅ CB-0044 (plain) [31-36] Wire Format — `[0100BEEF version header]`
- ✅ CB-0045 (typescript) [74-89] Usage in @bsv/sdk — `import { Beef, MerklePath, Transaction, WhatsOnChain } from '@bsv/sdk'`

## docs/architecture/conformance.md

- ✅ CB-0046 (text) [31-48] Pipeline Flow — `TypeScript reference behavior`
- ✅ CB-0047 (bash) [70-72] Running The Pipeline — `pnpm conformance`
- ✅ CB-0048 (bash) [76-78] Running The Pipeline — `pnpm conformance --validate-only`
- ✅ CB-0049 (bash) [82-84] Running The Pipeline — `pnpm conformance --vectors conformance/vectors/wallet/brc100`
- ✅ CB-0050 (bash) [88-90] Running The Pipeline — `pnpm --filter @bsv/conformance-runner-ts test`

## docs/architecture/identity.md

- ✅ CB-0051 (plain) [40-50] BRC-31 — HTTP Mutual Authentication Handshake — `Client request:`

## docs/conformance/contributing-vectors.md

- ✅ CB-0052 (json) [36-60] File Format — `{`
- ✅ CB-0053 (text) [68-73] Naming Rules — `sdk.crypto.ecdsa`
- ✅ CB-0054 (text) [81-92] Directory Selection — `conformance/vectors/`
- ✅ CB-0055 (bash) [105-107] Adding A Vector To An Existing File — `pnpm conformance --validate-only`
- ✅ CB-0056 (bash) [111-113] Adding A Vector To An Existing File — `pnpm --filter @bsv/conformance-runner-ts test`

## docs/conformance/index.md

- ✅ CB-0057 (json) [56-78] Vector Format — `{`

## docs/conformance/runner-ts.md

- ✅ CB-0058 (bash) [21-23] Structural Runner — `pnpm conformance`
- ✅ CB-0059 (text) [27-29] Structural Runner — `conformance/runner/src/runner.js`
- ✅ CB-0060 (bash) [48-52] Structural Runner — `pnpm conformance --validate-only`
- ✅ CB-0061 (bash) [58-60] TypeScript/Jest Behavior Runner — `pnpm --filter @bsv/conformance-runner-ts test`
- ✅ CB-0062 (text) [64-66] TypeScript/Jest Behavior Runner — `conformance/runner/ts/runner.test.ts`
- ✅ CB-0063 (bash) [86-88] Debugging A Vector — `pnpm conformance --vectors conformance/vectors/wallet/brc100`
- ✅ CB-0064 (bash) [92-94] Debugging A Vector — `sed -n '1,220p' conformance/vectors/wallet/brc100/getpublickey.json`
- ✅ CB-0065 (yaml) [100-114] CI Use — `- name: Validate conformance vectors`

## docs/conformance/vectors.md

- ✅ CB-0066 (text) [21-32] Repository Layout — `conformance/vectors/`
- ✅ CB-0067 (json) [38-56] Vector Format — `{`
- ✅ CB-0068 (bash) [121-123] Running Vectors — `pnpm conformance`
- ✅ CB-0069 (bash) [127-129] Running Vectors — `pnpm conformance --validate-only`
- ✅ CB-0070 (bash) [133-135] Running Vectors — `pnpm conformance --vectors conformance/vectors/wallet/brc100`
- ✅ CB-0071 (bash) [139-141] Running Vectors — `pnpm conformance --report conformance/runner/reports/results.xml`

## docs/get-started/choose-your-stack.md

- ✅ CB-0072 (text) [17-32] Choose Your Stack — `Browser app using a user's wallet?`
- ✅ CB-0073 (bash) [38-40] Browser App — `npm install @bsv/simple`
- ✅ CB-0074 (typescript) [42-53] Browser App — `import { createWallet } from '@bsv/simple/browser'`
- ✅ CB-0075 (bash) [63-65] Transaction Builder — `npm install @bsv/wallet-helper`
- ✅ CB-0076 (bash) [77-79] Server Agent — `npm install @bsv/simple`
- ✅ CB-0077 (typescript) [81-89] Server Agent — `import { ServerWallet } from '@bsv/simple/server'`
- ✅ CB-0078 (bash) [97-99] Wallet Builder — `npm install @bsv/wallet-toolbox`
- ✅ CB-0079 (bash) [113-115] Protocol Engineer — `npm install @bsv/sdk`

## docs/get-started/index.md

- ✅ CB-0080 (bash) [19-21] Step 1: Install — `npm install @bsv/simple`
- ✅ CB-0081 (typescript) [31-38] Step 2: Connect to a User Wallet — `import { createWallet } from '@bsv/simple/browser'`
- ✅ CB-0082 (typescript) [46-54] Step 3: Do Something Useful — `const recipientIdentityKey = '025706528f0f6894b2ba505007267ccff1133e004452a1f6b72ac716f246216366'`
- ✅ CB-0083 (typescript) [58-66] Step 3: Do Something Useful — `const created = await wallet.createToken({`
- ✅ CB-0084 (typescript) [70-80] Step 3: Do Something Useful — `const client = wallet.getClient()`
- ✅ CB-0085 (typescript) [86-96] Server Agents — `import { ServerWallet } from '@bsv/simple/server'`

## docs/get-started/install.md

- ✅ CB-0086 (bash) [25-27] Install @bsv/simple — `npm install @bsv/simple @bsv/sdk`
- ✅ CB-0087 (typescript) [40-43] Browser — `import { createWallet, Certifier, DID, Overlay } from '@bsv/simple/browser'`
- ✅ CB-0088 (typescript) [47-49] Server — `import { ServerWallet, FileRevocationStore } from '@bsv/simple/server'`
- ✅ CB-0089 (typescript) [53-55] Server — `const { ServerWallet } = await import('@bsv/simple/server')`
- ✅ CB-0090 (typescript) [61-64] TypeScript — `import type { BrowserWallet } from '@bsv/simple/browser'`
- ✅ CB-0091 (typescript) [72-77] Next.js — `const nextConfig = {`
- ✅ CB-0092 (bash) [93-95] Protocol-Level Work — `npm install @bsv/sdk`

## docs/guides/http-402-payments.md

- ✅ CB-0093 (bash) [41-53] Step 1 — Create server and client projects — `# Server`
- ✅ CB-0094 (json) [57-66] Client (in separate directory) — `{`
- ✅ CB-0095 (typescript) [72-138] Step 2 — Set up server wallet and payment middleware — `import express from 'express'`
- ✅ CB-0096 (typescript) [159-178] Step 4 — Set up client wallet and create 402-pay wrapper — `import { create402Fetch } from '@bsv/402-pay/client'`
- ✅ CB-0097 (typescript) [190-213] Step 5 — Make authenticated requests with auto-payment — `export async function accessFreeContent(fetch402: any) {`
- ✅ CB-0098 (typescript) [228-249] Step 6 — Manual payment construction (advanced) — `import { constructPaymentHeaders } from '@bsv/402-pay/client'`
- ✅ CB-0099 (typescript) [262-311] Putting it all together — `import express from 'express'`
- ✅ CB-0100 (typescript) [315-346] Putting it all together — `import { create402Fetch } from '@bsv/402-pay/client'`
- ✅ CB-0101 (bash) [350-358] Putting it all together — `# Terminal 1: Server`

## docs/guides/peer-to-peer-messaging.md

- ✅ CB-0102 (bash) [43-48] Step 1 — Install messaging packages — `mkdir my-p2p-app && cd my-p2p-app`
- ✅ CB-0103 (typescript) [54-68] Step 2 — Set up a wallet for identity — `import { WalletClient } from '@bsv/sdk'`
- ✅ CB-0104 (typescript) [76-106] Step 3 — Send a message via MessageBox (HTTP store-and-forward) — `import { MessageBoxClient } from '@bsv/message-box-client'`
- ✅ CB-0105 (typescript) [118-143] Step 4 — Retrieve messages from inbox — `export async function listInboxMessages(`
- ✅ CB-0106 (typescript) [155-173] Step 5 — Acknowledge (delete) messages after reading — `export async function acknowledgeMessages(`
- ✅ CB-0107 (typescript) [181-208] Step 6 — Listen for live messages via WebSocket — `export async function listenForLiveMessages(`
- ✅ CB-0108 (typescript) [220-246] Step 7 — Use Authsocket for custom WebSocket messaging — `import { AuthSocketClient } from '@bsv/authsocket-client'`
- ✅ CB-0109 (typescript) [259-327] Putting it all together — `import { WalletClient } from '@bsv/sdk'`
- ✅ CB-0110 (bash) [331-333] Putting it all together — `npx ts-node main.ts`

## docs/guides/run-overlay-node.md

- ✅ CB-0111 (bash) [43-49] Step 1 — Create Express app and install packages — `mkdir my-overlay-node && cd my-overlay-node`
- ✅ CB-0112 (json) [53-63] Step 1 — Create Express app and install packages — `{`
- ✅ CB-0113 (bash) [69-77] Step 2 — Set up environment and configuration — `SERVER_PRIVATE_KEY=<your-32-byte-hex-private-key>`
- ✅ CB-0114 (bash) [81-83] Step 2 — Set up environment and configuration — `node -e "console.log(require('@bsv/sdk').PrivateKey.fromRandom().toHex())"`
- ✅ CB-0115 (typescript) [89-126] Step 3 — Initialize OverlayExpress with basic configuration — `import OverlayExpress from '@bsv/overlay-express'`
- ✅ CB-0116 (typescript) [138-171] Step 4 — Register topic managers — `import {`
- ✅ CB-0117 (typescript) [183-234] Step 5 — Configure GASP sync and health checks — `async function configureAdvanced(server: OverlayExpress) {`
- ✅ CB-0118 (typescript) [246-275] Step 6 — Build engine and start the server — `async function main() {`
- ✅ CB-0119 (bash) [287-292] Step 7 — Advertise via SHIP/SLAP (optional) — `# Using curl to trigger advertisement sync (requires admin token)`
- ✅ CB-0120 (typescript) [300-374] Putting it all together — `import OverlayExpress from '@bsv/overlay-express'`
- ✅ CB-0121 (bash) [378-381] Putting it all together — `npm install`

## docs/guides/wallet-aware-app.md

- ✅ CB-0122 (bash) [36-38] Step 1 - Install — `npm install @bsv/sdk @bsv/simple`
- ✅ CB-0123 (typescript) [44-54] Step 2 - Connect To The User Wallet — `import { WalletClient } from '@bsv/sdk'`
- ✅ CB-0124 (typescript) [60-67] Step 3 - Use The Simple Browser Helper — `import { createWallet } from '@bsv/simple/browser'`
- ✅ CB-0125 (typescript) [71-73] Step 3 - Use The Simple Browser Helper — `const rawWallet = appWallet.getClient()`
- ✅ CB-0126 (typescript) [79-87] Step 4 - Create A Payment — `const result = await appWallet.pay({`
- ✅ CB-0127 (typescript) [91-111] Step 4 - Create A Payment — `import { P2PKH, WalletClient } from '@bsv/sdk'`
- ✅ CB-0128 (typescript) [119-130] Step 5 - Create And List Basket Outputs — `const token = await appWallet.createToken({`
- ✅ CB-0129 (typescript) [134-142] Step 5 - Create And List Basket Outputs — `const outputs = await appWallet.getClient().listOutputs({`
- ✅ CB-0130 (typescript) [155-163] Step 6 - Choose The Right Runtime — `import { ServerWallet } from '@bsv/simple/server'`

## docs/index.md

- ✅ CB-0131 (typescript) [39-50] Minimal App Example — `import { createWallet } from '@bsv/simple/browser'`

## docs/infrastructure/chaintracks-server.md

- ✅ CB-0132 (plain) [39-46] API — `GET /blockHeaderForHeight?height=100`
- ✅ CB-0133 (bash) [52-58] Configuration — `# Bootstrap from another Chaintracks server`

## docs/infrastructure/message-box-server.md

- ✅ CB-0134 (bash) [76-91] Run locally — `# Install dependencies`
- ✅ CB-0135 (bash) [95-110] Deploy to production — `# Build Docker image`
- ✅ CB-0136 (bash) [118-120] Migrations — `npm run migrate`

## docs/infrastructure/overlay-server.md

- ✅ CB-0137 (bash) [67-82] Run locally — `# Install dependencies`
- ✅ CB-0138 (bash) [86-106] Deploy to production — `# Multi-stage build: Node builder → production runtime`

## docs/infrastructure/uhrp-server-basic.md

- ✅ CB-0139 (bash) [66-78] Run locally — `# Install dependencies`
- ✅ CB-0140 (bash) [84-96] Deploy to production — `# Build and start`

## docs/infrastructure/uhrp-server-cloud-bucket.md

- ✅ CB-0141 (bash) [73-85] Run locally — `# Install dependencies`
- ✅ CB-0142 (bash) [91-104] Deploy to production — `# Multi-stage build: Node 22 alpine builder → production runtime`

## docs/infrastructure/wab.md

- ✅ CB-0143 (bash) [77-95] Run locally — `# Install dependencies`
- ✅ CB-0144 (bash) [101-132] Deploy to production — `# Build Docker image`
- ✅ CB-0145 (bash) [138-140] Migrations — `npm run migrate`

## docs/infrastructure/wallet-infra.md

- ✅ CB-0146 (bash) [68-83] Run locally — `# Install dependencies`
- ✅ CB-0147 (bash) [87-113] Deploy to production — `# Multi-stage Docker build: Node 22 alpine → production`

## docs/packages/helpers/amountinator.md

- ✅ CB-0148 (bash) [24-26] Install — `npm install @bsv/amountinator`
- ✅ CB-0149 (typescript) [30-43] Quick start — `import { CurrencyConverter } from '@bsv/amountinator'`
- ✅ CB-0150 (typescript) [59-62] Initialize with auto-refresh — `const converter = new CurrencyConverter()  // 5-min interval`
- ✅ CB-0151 (typescript) [65-69] Convert with auto-detection — `const formatted = await converter.convertAmount('5000')  // "5000" or "0.1" or "10 USD"`
- ✅ CB-0152 (typescript) [72-74] Convert between specific currencies — `const usdAmount = converter.convertCurrency(0.1, 'BSV', 'USD')  // 6.2 (if rate = 62)`
- ✅ CB-0153 (typescript) [77-79] Get preferred currency symbol — `const symbol = converter.getCurrencySymbol()  // "$" if USD, "€" if EUR`
- ✅ CB-0154 (typescript) [82-85] Convert user currency to satoshis — `const sats = await converter.convertToSatoshis(10)  // If preferred = 'USD', USD→SATS`
- ✅ CB-0155 (typescript) [88-93] Static converter (no auto-refresh) — `const staticConverter = new CurrencyConverter(0)  // refreshInterval = 0`

## docs/packages/helpers/did-client.md

- ✅ CB-0156 (bash) [24-26] Install — `npm install @bsv/did-client`
- ✅ CB-0157 (typescript) [30-54] Quick start — `import { DIDClient } from '@bsv/did-client'`
- ✅ CB-0158 (typescript) [69-80] Create a DID token — `const createResult = await didClient.createDID(`
- ✅ CB-0159 (typescript) [83-96] Find DID tokens on overlay — `const foundDIDs = await didClient.findDID(`
- ✅ CB-0160 (typescript) [99-103] Query by outpoint — `const byOutpoint = await didClient.findDID({`
- ✅ CB-0161 (typescript) [106-114] Revoke DID by serial number — `const revokeResult = await didClient.revokeDID({`
- ✅ CB-0162 (typescript) [117-125] Pagination and filtering — `const page1 = await didClient.findDID({`

## docs/packages/helpers/fund-wallet.md

- ✅ CB-0163 (bash) [24-26] Install — `npm install @bsv/fund-wallet`
- ✅ CB-0164 (bash) [30-52] Quick start — `# Check balance only`
- ✅ CB-0165 (bash) [68-72] Check balance only (no Metanet Desktop needed) — `npx fund-metanet \`
- ✅ CB-0166 (bash) [75-80] Fund wallet (Metanet Desktop must be running) — `npx fund-metanet \`
- ✅ CB-0167 (bash) [83-89] Using custom storage provider — `npx fund-metanet \`
- ✅ CB-0168 (bash) [92-95] Interactive mode — `npx fund-metanet`

## docs/packages/helpers/simple.md

- ✅ CB-0169 (bash) [24-26] Install — `npm install @bsv/simple`
- ✅ CB-0170 (typescript) [30-43] Quick start — `import { createWallet } from '@bsv/simple/browser'`
- ✅ CB-0171 (typescript) [60-67] Check wallet balance — `const balance = await wallet.getBalance()`
- ✅ CB-0172 (typescript) [70-77] Register for MessageBox and send payment — `// Register identity handle`
- ✅ CB-0173 (typescript) [80-98] Create and transfer tokens — `const recipientIdentityKey = '025706528f0f6894b2ba505007267ccff1133e004452a1f6b72ac716f246216366'`
- ✅ CB-0174 (typescript) [101-116] Direct payments (BRC-29 derivation) — `// Server generates payment request`

## docs/packages/helpers/templates.md

- ✅ CB-0175 (bash) [24-26] Install — `npm install @bsv/templates`
- ✅ CB-0176 (typescript) [30-40] Quick start — `import { OpReturn } from '@bsv/templates'`
- ✅ CB-0177 (typescript) [53-60] Create and decode an OP_RETURN script — `import { OpReturn } from '@bsv/templates'`
- ✅ CB-0178 (typescript) [63-95] Create MultiPushDrop token with 2 trusted owners — `import { SecurityLevel, Utils, type WalletInterface } from '@bsv/sdk'`
- ✅ CB-0179 (typescript) [98-124] Create 2-of-3 multisig — `import { PublicKey, type WalletInterface } from '@bsv/sdk'`

## docs/packages/helpers/wallet-helper.md

- ✅ CB-0180 (bash) [28-30] Install — `npm install @bsv/wallet-helper`
- ✅ CB-0181 (typescript) [34-50] Quick start — `import { TransactionBuilder } from '@bsv/wallet-helper'`
- ✅ CB-0182 (typescript) [67-75] Multi-output payment with wallet-managed change — `const aliceAddress = '1EvmsbpAY7nESLkN4ajLTMbvsaQ1HpJPGX'`
- ✅ CB-0183 (typescript) [82-88] Self-controlled output with BRC-29 automatic derivation — `await new TransactionBuilder(wallet, "Self-controlled output")`
- ✅ CB-0184 (typescript) [91-98] Spend UTXOs and send to recipient — `const recipientAddress = '1EvmsbpAY7nESLkN4ajLTMbvsaQ1HpJPGX'`
- ✅ CB-0185 (typescript) [101-113] Create 1-sat ordinal with inscription and metadata — `const ordResult = await new TransactionBuilder(wallet, "Mint ordinal")`

## docs/packages/index.md

- ✅ CB-0186 (bash) [96-98] Installation — `npm install @bsv/sdk`
- ✅ CB-0187 (bash) [102-104] Installation — `npm install @bsv/wallet-toolbox @bsv/overlay @bsv/authsocket`

## docs/packages/messaging/authsocket-client.md

- ✅ CB-0188 (bash) [24-26] Install — `npm install @bsv/authsocket-client`
- ✅ CB-0189 (typescript) [30-49] Quick start — `import { AuthSocketClient } from '@bsv/authsocket-client'`
- ✅ CB-0190 (typescript) [65-80] Basic authenticated connection — `import { AuthSocketClient } from '@bsv/authsocket-client'`
- ✅ CB-0191 (typescript) [84-94] With custom manager options — `const socket = AuthSocketClient('http://localhost:3000', {`

## docs/packages/messaging/authsocket.md

- ✅ CB-0192 (bash) [24-26] Install — `npm install @bsv/authsocket`
- ✅ CB-0193 (typescript) [30-50] Quick start — `import { AuthSocketServer } from '@bsv/authsocket'`
- ✅ CB-0194 (typescript) [66-88] Server setup with certificate requests — `import { AuthSocketServer } from '@bsv/authsocket'`
- ✅ CB-0195 (typescript) [92-102] Receiving authenticated messages — `io.on('connection', async (socket) => {`

## docs/packages/messaging/message-box-client.md

- ✅ CB-0196 (bash) [24-26] Install — `npm install @bsv/message-box-client`
- ✅ CB-0197 (typescript) [30-57] Quick start — `import { MessageBoxClient } from '@bsv/message-box-client'`
- ✅ CB-0198 (typescript) [74-87] Listening for live messages — `const msgBoxClient = new MessageBoxClient({`
- ✅ CB-0199 (typescript) [91-109] Peer-to-peer payments — `import { PeerPayClient } from '@bsv/message-box-client'`

## docs/packages/messaging/paymail.md

- ✅ CB-0200 (bash) [24-26] Install — `npm install @bsv/paymail`
- ✅ CB-0201 (typescript) [30-46] Quick start — `import { PaymailClient, PublicProfileCapability } from '@bsv/paymail'`
- ✅ CB-0202 (typescript) [63-101] Server setup — `import express from 'express'`
- ✅ CB-0203 (typescript) [105-125] Client capability discovery — `import { PaymailClient, PublicProfileCapability } from '@bsv/paymail'`

## docs/packages/middleware/402-pay.md

- ✅ CB-0204 (bash) [24-26] Install — `npm install @bsv/402-pay`
- ✅ CB-0205 (typescript) [30-64] Quick start — `// ===== SERVER SIDE =====`
- ✅ CB-0206 (typescript) [89-108] Server low-level API — `import express from 'express'`
- ✅ CB-0207 (typescript) [112-123] Client manual headers — `import { constructPaymentHeaders } from '@bsv/402-pay/client'`
- ✅ CB-0208 (typescript) [127-139] Client with cache management — `const fetch402 = create402Fetch({`

## docs/packages/middleware/auth-express-middleware.md

- ✅ CB-0209 (bash) [24-26] Install — `npm install @bsv/auth-express-middleware`
- ✅ CB-0210 (typescript) [30-52] Quick start — `import express from 'express'`
- ✅ CB-0211 (typescript) [69-82] Global auth requirement — `import express from 'express'`
- ✅ CB-0212 (typescript) [86-105] Certificate handling — `function onCertificatesReceived(senderPublicKey, certs, req, res, next) {`
- ✅ CB-0213 (typescript) [109-113] Per-route protection — `app.post('/secure-endpoint', createAuthMiddleware({ wallet }), (req, res) => {`

## docs/packages/middleware/payment-express-middleware.md

- ✅ CB-0214 (bash) [24-26] Install — `npm install @bsv/payment-express-middleware @bsv/auth-express-middleware @bsv/simple`
- ✅ CB-0215 (typescript) [30-63] Quick start — `import express from 'express'`
- ✅ CB-0216 (typescript) [80-100] Basic payment gating — `import express from 'express'`
- ✅ CB-0217 (typescript) [104-113] Dynamic pricing — `const paymentMiddleware = createPaymentMiddleware({`
- ✅ CB-0218 (typescript) [117-136] Chained with auth middleware — `const app = express()`

## docs/packages/network/teranode-listener.md

- ✅ CB-0219 (bash) [20-22] Install — `npm install @bsv/teranode-listener`
- ✅ CB-0220 (typescript) [26-44] Quick start — `import { TeranodeListener } from '@bsv/teranode-listener'`
- ✅ CB-0221 (typescript) [61-70] Subscribe with callbacks — `const listener = new TeranodeListener({`
- ✅ CB-0222 (typescript) [74-87] Custom configuration — `const listener = new TeranodeListener(`
- ✅ CB-0223 (typescript) [91-111] Dynamic topic management — `const listener = new TeranodeListener({`
- ✅ CB-0224 (typescript) [115-120] Graceful shutdown — `const listener = new TeranodeListener(callbacks, config)`

## docs/packages/overlays/btms-backend.md

- ✅ CB-0225 (bash) [26-28] Install — `npm install @bsv/btms-backend`
- ✅ CB-0226 (typescript) [32-54] Quick start — `import { BTMSTopicManager, BTMSLookupServiceFactory } from '@bsv/btms-backend'`
- ✅ CB-0227 (typescript) [70-83] Register in OverlayExpress — `import OverlayExpress from '@bsv/overlay-express'`
- ✅ CB-0228 (typescript) [87-92] Query tokens by owner — `const ownerResults = await lookupService.lookup({`
- ✅ CB-0229 (typescript) [96-101] Retrieve metadata — `const manager = new BTMSTopicManager()`

## docs/packages/overlays/gasp.md

- ✅ CB-0230 (bash) [24-26] Install — `npm install @bsv/gasp`
- ✅ CB-0231 (typescript) [30-101] Quick start — `import {`
- ✅ CB-0232 (typescript) [117-164] Implement GASPRemote for HTTP communication — `import {`
- ✅ CB-0233 (typescript) [168-182] Unidirectional (pull-only) sync — `const gaspPullOnly = new GASP(`
- ✅ CB-0234 (typescript) [186-200] Sequential sync for DB safety — `const gaspSequential = new GASP(`

## docs/packages/overlays/overlay-discovery-services.md

- ✅ CB-0235 (bash) [20-22] Install — `npm install @bsv/overlay-discovery-services`
- ✅ CB-0236 (typescript) [26-86] Quick start — `import { Engine, type LookupService, type Storage, type TopicManager } from '@bsv/overlay'`
- ✅ CB-0237 (typescript) [101-106] Validate URIs and names — `import { isAdvertisableURI, isValidTopicOrServiceName } from '@bsv/overlay-discovery-services'`
- ✅ CB-0238 (typescript) [110-127] Use WalletAdvertiser for publishing — `import { WalletAdvertiser } from '@bsv/overlay-discovery-services'`
- ✅ CB-0239 (typescript) [131-148] Discover peers via SHIP/SLAP — `// After Engine is initialized with tracker URLs`

## docs/packages/overlays/overlay-express.md

- ✅ CB-0240 (bash) [20-22] Install — `npm install @bsv/overlay-express`
- ✅ CB-0241 (typescript) [26-46] Quick start — `import OverlayExpress from '@bsv/overlay-express'`
- ✅ CB-0242 (typescript) [62-71] Basic server setup — `const server = new OverlayExpress(`
- ✅ CB-0243 (typescript) [75-86] Register multiple topics — `server.configureTopicManager('tm_helloworld', new HelloWorldTopicManager())`
- ✅ CB-0244 (typescript) [90-106] Configure health checks — `server.configureHealth({`
- ✅ CB-0245 (typescript) [110-122] Advanced engine options — `server.configureEngineParams({`

## docs/packages/overlays/overlay-topics.md

- ✅ CB-0246 (bash) [20-22] Install — `npm install @bsv/overlay-topics`
- ✅ CB-0247 (typescript) [26-40] Quick start — `import { HelloWorldTopicManager, createHelloWorldLookupService } from '@bsv/overlay-topics'`
- ✅ CB-0248 (typescript) [55-78] Register multiple topics in OverlayExpress — `import OverlayExpress from '@bsv/overlay-express'`
- ✅ CB-0249 (typescript) [82-103] Query by topic — `// DID query`
- ✅ CB-0250 (typescript) [107-111] Manual topic manager use — `const manager = new DIDTopicManager()`

## docs/packages/overlays/overlay.md

- ✅ CB-0251 (bash) [20-22] Install — `npm install @bsv/overlay @bsv/overlay-topics`
- ✅ CB-0252 (typescript) [26-60] Quick start — `import { Engine } from '@bsv/overlay'`
- ✅ CB-0253 (typescript) [76-97] Implementing a TopicManager — `import type { TopicManager } from '@bsv/overlay'`
- ✅ CB-0254 (typescript) [101-134] Implementing a LookupService — `import type { LookupService } from '@bsv/overlay'`
- ✅ CB-0255 (typescript) [138-141] Configuring storage with Knex — `const storage = new KnexStorage(knex)`

## docs/packages/sdk/bsv-sdk.md

- ✅ CB-0256 (bash) [24-26] Install — `npm install @bsv/sdk`
- ✅ CB-0257 (typescript) [30-57] Quick start — `import { PrivateKey, P2PKH, Transaction } from '@bsv/sdk'`
- ✅ CB-0258 (typescript) [80-106] Build a P2PKH transaction — `import { PrivateKey, P2PKH, Transaction } from '@bsv/sdk'`
- ✅ CB-0259 (typescript) [110-133] Connect to a BRC-100 wallet — `import { P2PKH, WalletClient } from '@bsv/sdk'`
- ✅ CB-0260 (typescript) [139-167] Verify SPV with merkle proof — `import { Transaction, WhatsOnChain } from '@bsv/sdk'`
- ✅ CB-0261 (typescript) [171-191] Encode data on-chain with PushDrop — `import { PushDrop, Utils, WalletClient } from '@bsv/sdk'`

## docs/packages/sdk/index.md

- ✅ CB-0262 (typescript) [58-88] Quick Example — `import { PrivateKey, P2PKH, Transaction } from '@bsv/sdk'`

## docs/packages/wallet/btms-permission-module.md

- ✅ CB-0263 (bash) [25-27] Install — `npm install @bsv/btms-permission-module`
- ✅ CB-0264 (typescript) [31-51] Quick start — `import { createBtmsModule } from '@bsv/btms-permission-module'`
- ✅ CB-0265 (typescript) [65-85] Simple prompt with confirm dialog (vanilla JS) — `import { createBtmsModule } from '@bsv/btms-permission-module'`
- ✅ CB-0266 (typescript) [89-99] Deny-all for programmatic use (no UI needed) — `import { createBtmsModule } from '@bsv/btms-permission-module'`
- ✅ CB-0267 (typescript) [103-123] Register with wallet permissions manager — `import { WalletPermissionsManager } from '@bsv/wallet-toolbox'`

## docs/packages/wallet/btms.md

- ✅ CB-0268 (bash) [39-41] Install — `npm install @bsv/btms`
- ✅ CB-0269 (typescript) [45-68] Quick start — `import { BTMS } from '@bsv/btms'`
- ✅ CB-0270 (typescript) [83-93] Send tokens to recipient — `const recipientIdentityKey = '025706528f0f6894b2ba505007267ccff1133e004452a1f6b72ac716f246216366'`
- ✅ CB-0271 (typescript) [97-104] Accept incoming token payment — `const incoming = await btms.listIncoming()`
- ✅ CB-0272 (typescript) [108-115] Burn tokens (permanent destruction) — `// Burn specific amount`
- ✅ CB-0273 (typescript) [119-136] Prove token ownership for collateral or escrow — `const verifierKey = '02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5'`

## docs/packages/wallet/wallet-relay.md

- ✅ CB-0274 (bash) [21-23] Install — `npm install @bsv/wallet-relay`
- ✅ CB-0275 (typescript) [29-55] Set up relay server (Express + Node.js) — `import express from 'express'`
- ✅ CB-0276 (tsx) [59-87] Create session and get QR code (frontend React) — `import { useWalletRelayClient } from '@bsv/wallet-relay/react'`
- ✅ CB-0277 (tsx) [122-142] Use WalletConnectionModal component — `import { WalletConnectionModal } from '@bsv/wallet-relay/react'`
- ✅ CB-0278 (typescript) [146-170] Send wallet RPC call from desktop to mobile — `import { WalletRelayClient } from '@bsv/wallet-relay/client'`
- ✅ CB-0279 (typescript) [174-192] Mobile wallet implementation — `import { WalletPairingSession, parsePairingUri } from '@bsv/wallet-relay/client'`

## docs/packages/wallet/wallet-toolbox-examples.md

- ✅ CB-0280 (bash) [21-23] Install — `npm install @bsv/wallet-toolbox-examples`

## docs/packages/wallet/wallet-toolbox.md

- ✅ CB-0281 (bash) [23-25] Install — `npm install @bsv/wallet-toolbox`
- ✅ CB-0282 (bash) [29-32] Install — `npm install @bsv/wallet-toolbox-client`
- ✅ CB-0283 (typescript) [52-66] Source-Backed Setup Pattern — `import { Setup } from '@bsv/wallet-toolbox'`
- ✅ CB-0284 (typescript) [74-98] Action Flow — `export async function createP2pkhOutput(recipientAddress: string) {`
- ✅ CB-0285 (typescript) [102-132] Action Flow — `export async function finishCustomSpend(args: {`

## docs/reference/brc-index.md

- ✅ CB-0286 (bash) [143-149] Finding Implementations — `# Packages implementing BRC-100`

## docs/specs/arc-broadcast.md

- ✅ CB-0287 (typescript) [82-106] Example: Submit transaction with SDK — `import { Transaction, ARC } from '@bsv/sdk'`
- ✅ CB-0288 (typescript) [112-127] Example: Submit transaction with SDK — `// POST /arc-callback`

## docs/specs/authsocket.md

- ✅ CB-0289 (typescript) [77-113] Example: Server setup — `import http from 'http'`
- ✅ CB-0290 (typescript) [117-141] Example: Server setup — `import { MessageBoxClient } from '@bsv/message-box-client'`

## docs/specs/brc-100-wallet.md

- ✅ CB-0291 (typescript) [54-56] createAction — `const result = await wallet.createAction(args)`
- ✅ CB-0292 (typescript) [102-112] createAction — `const result = await wallet.createAction({`
- ✅ CB-0293 (typescript) [118-120] signAction — `const result = await wallet.signAction(args)`
- ✅ CB-0294 (typescript) [148-156] signAction — `await wallet.signAction({`

## docs/specs/brc-121-402.md

- ✅ CB-0295 (typescript) [75-109] Example: Monetized Express endpoint — `import express from 'express'`
- ✅ CB-0296 (typescript) [113-125] Example: Monetized Express endpoint — `import { create402Fetch } from '@bsv/402-pay/client'`

## docs/specs/brc-29-peer-payment.md

- ✅ CB-0297 (typescript) [74-93] Example: Send peer-to-peer payment via message box — `import { PeerPayClient } from '@bsv/message-box-client'`
- ✅ CB-0298 (typescript) [97-112] Example: Send peer-to-peer payment via message box — `import { PeerPayClient } from '@bsv/message-box-client'`

## docs/specs/brc-31-auth.md

- ✅ CB-0299 (typescript) [87-114] Example: Express middleware handshake — `import express from 'express'`
- ✅ CB-0300 (typescript) [118-130] Example: Express middleware handshake — `import { AuthFetch } from '@bsv/sdk'`
- ✅ CB-0301 (typescript) [134-157] Example: WebSocket with AuthSocket — `import http from 'http'`

## docs/specs/gasp-sync.md

- ✅ CB-0302 (typescript) [93-194] Example: Sync two overlay nodes — `import {`

## docs/specs/merkle-service.md

- ✅ CB-0303 (typescript) [79-90] Example: Monitor transaction — `import { Transaction, WhatsOnChain } from '@bsv/sdk'`
- ✅ CB-0304 (typescript) [94-110] Example: Monitor transaction — `import { MerklePath, WhatsOnChain } from '@bsv/sdk'`

## docs/specs/message-box-http.md

- ✅ CB-0305 (typescript) [71-88] Example: Send encrypted message — `import { MessageBoxClient } from '@bsv/message-box-client'`
- ✅ CB-0306 (typescript) [92-106] Example: Send encrypted message — `// 2. Retrieve all messages in inbox`
- ✅ CB-0307 (typescript) [110-118] Example: Send encrypted message — `// 4. Subscribe to real-time messages`

## docs/specs/overlay-http.md

- ✅ CB-0308 (typescript) [82-123] Example: Submit transaction to overlay — `import { PushDrop, Utils, WalletClient } from '@bsv/sdk'`
- ✅ CB-0309 (typescript) [127-139] Example: Submit transaction to overlay — `const lookupResponse = await fetch('https://overlay.example.com/lookup', {`

## docs/specs/storage-adapter.md

- ✅ CB-0310 (typescript) [77-106] Example: Remote wallet over HTTPS — `import { SetupClient } from '@bsv/wallet-toolbox'`

## docs/specs/uhrp.md

- ✅ CB-0311 (typescript) [79-106] Example: Upload and retrieve file — `import { StorageUploader, StorageDownloader, WalletClient } from '@bsv/sdk'`
- ✅ CB-0312 (typescript) [110-132] Example: Upload and retrieve file — `import { LookupResolver } from '@bsv/sdk'`
