# Overlay Service Deployment (for LARS)
This guide describes how to deploy the MessageBox overlay service located in the backend/ directory. This service integrates with SHIP and is deployed via LARS, the Lightweight Authenticated Routing Service.
________________________________________
### Overview
This overlay module enables remote identity resolution and host advertisement via SHIP, by providing:

- Parsing of PushDrop overlay advertisements
- SHIP-compatible lookup via identity key
- Host-to-identity attestation storage in MongoDB
- Compatibility with SHIPBroadcaster and LookupResolver

This service does not expose HTTP or WebSocket endpoints directly. It must be deployed inside a LARS overlay container.

________________________________________
### Directory Overview
```bash
backend/
├── services/
│   ├── MessageBoxStorage.ts       # MongoDB-based storage logic
│   ├── MessageBoxLookupService.ts # SHIP lookup and advertisement parsing
│   ├── MessageBoxTopicManager.ts  # Signature verification for overlay TX outputs
├── migrations/                    # MySQL table for overlay_ads
├── MessageBoxLookupDocs.md.js     # Lookup documentation for LARS
├── MessageBoxTopicDocs.md.js      # TopicManager documentation for LARS
└── DEPLOYING.md                   # This file
```
________________________________________
### Deployment with LARS
This overlay service is meant to be plugged into LARS using deployment-info.json configuration file.
**Step 1:** Install and Run LARS
Follow setup instructions for LARS:
```bash
npm install -g @bsv/lars
mkdir my-overlay-project && cd my-overlay-project
lars init
```
________________________________________
**Step 2:** Mount MessageBox Overlay Code
Place the backend/ folder from MessageBox into your LARS src/ directory:
```css
my-overlay-project/
└── src/
    └── messagebox/
        └── [paste backend/ contents here]
```
________________________________________
**Step 3:** Configure LARS
Edit deployment-info.json in the LARS root:
```json
{
  "schema": "bsv-app",
  "topicManagers": {
    "tm_messagebox": "./src/messagebox/services/MessageBoxTopicManager.ts"
  },
  "lookupServices": {
    "ls_messagebox": {
      "serviceFactory": "./src/messagebox/services/MessageBoxLookupService.ts",
      "hydrateWith": "mongo"
    }
  }
}
```
Note: hydrateWith: "mongo" instructs LARS to pass a MongoDB instance to your service factory.
________________________________________
### MongoDB Setup
LARS will not run any migrations. You must provide an active MongoDB database via environment variables.

Set the following environment variables:

Variable
MONGO_URI	mongodb://localhost:27017
MONGO_DB	messagebox_overlay

These can go in .env, .larsrc, or be set inline:

```bash
MONGO_URI=mongodb://localhost:27017 
MONGO_DB=messagebox_overlay 
lars start
```
The MessageBoxStorage class will create and query a overlay_ads collection automatically.

________________________________________
### Local Dev Testing
You can test overlay behavior using:
- @bsv/overlay-express or @bsv/sdk’s SHIPBroadcaster
- LookupResolver to resolve identity → host

The lookup method is exposed via the LARS overlay port (default: 3010):
```ts
import { LookupResolver } from '@bsv/sdk'

const resolver = new LookupResolver({
  networkPreset: 'local', // or 'test' or 'main'
  overlayPorts: {
    'tm_messagebox': 3010
  }
})

const host = await resolver.resolveHostForIdentity({
  identityKey: '03abc...'
})
```
________________________________________
### Documentation
This overlay service provides built-in docs through:
- getDocumentation() → Markdown content in MessageBoxLookupDocs.md.js
- getMetaData() → Service name and description for LARS UI
________________________________________
### What This Deploys
- A SHIP-compatible overlay service that:
    - Validates MessageBox overlay outputs
    - Parses and stores advertisement data
    - Answers SHIP lookup queries
- Includes full documentation and metadata
- Works seamlessly with the MetaNet client SDK
________________________________________
### Used By
- [MessageBoxClient](https://github.com/bitcoin-sv/p2p
- [PeerPay](https://github.com/bitcoin-sv/p2p
- Overlay-aware apps built using SHIP & Babbage
________________________________________
### License
This code is licensed under the [Open BSV License](https://www.bsvlicense.org/).
________________________________________


