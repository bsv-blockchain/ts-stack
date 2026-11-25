---
release:
  "@bsv/message-box-client": minor
---
PaymentToken now keeps an optional, bounded note and paymail from an incoming MessageBox payment. note is text of at most 500 characters and 2,000 bytes with no control characters; paymail is a name@domain address of at most 254 bytes. An invalid value is dropped and the payment is still returned. The token keeps exactly its old shape when the sender sent neither. Both fields are unverified text chosen by the sender. A token that carries a sender field is still rejected.

## Migration

No migration required. note and paymail are optional and absent on older senders.
