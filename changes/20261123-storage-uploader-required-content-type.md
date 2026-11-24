---
release:
  "@bsv/sdk": patch
---
StorageUploader.publishFile now sends the provider's required content-type header in place of the file's own type, so signed upload URLs that cover content-type no longer reject the PUT with 403. With no required content type the file's type is still sent.

## Migration

No consumer migration is required.
