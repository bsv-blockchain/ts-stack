# External Data Services Necessary to Wallet Operations

The principal purpsose of these services is to insulate the rest of the code from the APIs of external service providers.

These services include:

- Posting BEEFs to transaction processors.
- Maintaining a local trusted block header database and answering merkleproof queries.
- Obtaining real time exchange rates.
- Raw transaction lookup by txid.
- UTXO status verification by lockingScript hash.
