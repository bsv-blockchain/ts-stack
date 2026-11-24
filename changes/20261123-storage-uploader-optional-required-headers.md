---
release:
  "@bsv/sdk": patch
---
StorageUploader again treats an upload reply without requiredHeaders as no extra upload headers, so paid uploads to go-uhrp-storage-server hosts no longer fail after payment. A present requiredHeaders, including null, is validated as before.

## Migration

No consumer migration is required.
