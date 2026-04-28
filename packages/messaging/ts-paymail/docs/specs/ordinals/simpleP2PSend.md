### Simple P2P Ordinal Transactions Specification

---

#### 1. Simple P2P Ordinal Payment Destinations


This protocol provides a mechanism for requesting payment destinations specifically for ordinal transactions. It is similar to the P2P Payment Destination protocol but tailored for handling simple ordinal sends.

#### Motivation
Ordinals introduce a specific need in the Bitcoin ecosystem for transaction types that are simpler and more focused. While existing P2P payment protocols provide a broad range of functionalities, there is a demand for a protocol that specifically caters to ordinal transactions. This need arises from the unique characteristics of ordinals, ordinal transactions can not be differentiated from regular bitcoin transactions so it is needed for a specific path where only ordinal transactions go though to prevent accidental burns of an ordinal

#### Capability Discovery

The `.well-known/bsvalias` document is updated to include a declaration of the endpoint for ordinal payment destinations:

```json
{
  "bsvalias": "1.0",
  "capabilities": {
    "cc2154bfa6a2": "https://example.bsvalias.tld/api/ordinal-p2p-payment-destination/{alias}@{domain.tld}"
  }
}
```

The capability `cc2154bfa6a2` returns a URI template where the client must perform a POST request with the number of ordinals to be sent.


#### Client Request

The request body structure:

```json
{
  "ordinals": 2
}
```

#### Server Response

```json
{
  "outputs": [
    {
      "script": "hex-encoded-locking-script"
    },
    {
      "script": "another-or-the-same-hex-locking-script"
    }
  ],
  "reference": "reference-id"
}
```

#### 2. Simple P2P Ordinal Receive Transaction
This protocol allows Paymail providers to receive simple ordinal transactions sent to their users.

#### Motivation

The growing usage of ordinals requires a dedicated protocol for receiving such transactions. The existing P2P transaction protocols handle a wide array of transaction types, but a more focused approach is needed for the simplicity and specificity of ordinal transactions.

#### Capability Discovery

The `.well-known/bsvalias` document includes a declaration for the ordinal transaction receiving endpoint:

```json
{
  "bsvalias": "1.0",
  "capabilities": {
    "2cc00c7f93c3": "https://example.bsvalias.tld/api/receive-ordinal-tx/{alias}@{domain.tld}"
  }
}
```

#### Client Request

The request body structure:

```json
{
  "hex": "hex-encoded-transaction",
  "reference": "reference-id",
  "metadata": {
    "sender": "someone@example.tld",
    "pubkey": "public-key",
    "signature": "signature",
    "note": "transaction-note"
  }
}
```


#### Server Response
```json
{
  "txid": "transaction-id",
  "note": "optional-note"
}
```

### Conclusion

These simple ordinal transaction capabilities are designed for straightforward and efficient handling of ordinal transactions. They complement the existing Paymail capabilities by focusing on a specific transaction type. As the ecosystem evolves, further protocols may be developed to accommodate more complex functions involving ordinals.