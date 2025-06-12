# Apps Overlay Services

Apps Overlay Services is a BSV overlay implementation that powers a decentralized, on-chain **Metanet App Catalog** using the PushDrop protocol.  
It supports publishing and resolving app metadata using the standard BSV SDK TopicBroadcaster and LookupResolver.

This repo includes:

- A **Topic Manager**: defines which UTXOs are admissible to the overlay
- A **Storage Manager**: persistently manages app catalog data using MongoDB
- A **Lookup Service**: enables fast app discovery by name, domain, or publisher

## App Metadata Schema
Each published Metanet app is represented by a signed PushDrop token with the following data schema:

```json
{
  "version": "0.1.0",
  "name": "Tempo",
  "description": "Feel the beat!",
  "icon": "https://tempomusic.net/favicon.ico",
  "httpURL": "https://tempomusic.net",
  "uhrpURL": "uhrp://xyczbfdsfs...",
  "domain": "tempomusic.net",
  "publisher": "identityKeyGoesHere",
  "release_date": "2025-06-12T12:00:00Z"
}
```
Optional fields include: short_name, category, tags, banner_image_url, changelog, screenshot_urls.

