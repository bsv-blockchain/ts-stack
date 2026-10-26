# API

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Variables](#variables)

## Interfaces

## Classes

## Functions

| |
| --- |
| [copyMessageBytes](#function-copymessagebytes) |
| [copyPrivateKey](#function-copyprivatekey) |
| [copyPublicKey](#function-copypublickey) |

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Variables](#variables)

---

### Function: copyMessageBytes

```ts
export function copyMessageBytes(value: number[], name: string, maximum: number = MAX_MESSAGE_PAYLOAD_BYTES, minimum: number = 0): number[]
```

See also: [MAX_MESSAGE_PAYLOAD_BYTES](./messages.md#variable-max_message_payload_bytes), [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Variables](#variables)

---
### Function: copyPrivateKey

```ts
export function copyPrivateKey(value: PrivateKey, name: string): PrivateKey
```

See also: [PrivateKey](./primitives.md#class-privatekey), [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Variables](#variables)

---
### Function: copyPublicKey

```ts
export function copyPublicKey(value: PublicKey, name: string): PublicKey
```

See also: [PublicKey](./primitives.md#class-publickey), [string](./remittance.md#function-string)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Variables](#variables)

---
## Variables

| |
| --- |
| [MAX_ENCRYPTED_MESSAGE_BYTES](#variable-max_encrypted_message_bytes) |
| [MAX_MESSAGE_PAYLOAD_BYTES](#variable-max_message_payload_bytes) |
| [MAX_SIGNED_MESSAGE_BYTES](#variable-max_signed_message_bytes) |
| [MIN_ENCRYPTED_MESSAGE_BYTES](#variable-min_encrypted_message_bytes) |
| [MIN_SIGNED_MESSAGE_BYTES](#variable-min_signed_message_bytes) |
| [decrypt](#variable-decrypt) |
| [encrypt](#variable-encrypt) |
| [sign](#variable-sign) |
| [verify](#variable-verify) |

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Variables](#variables)

---

### Variable: MAX_ENCRYPTED_MESSAGE_BYTES

```ts
MAX_ENCRYPTED_MESSAGE_BYTES = MAX_MESSAGE_PAYLOAD_BYTES + 150
```

See also: [MAX_MESSAGE_PAYLOAD_BYTES](./messages.md#variable-max_message_payload_bytes)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Variables](#variables)

---
### Variable: MAX_MESSAGE_PAYLOAD_BYTES

```ts
MAX_MESSAGE_PAYLOAD_BYTES = 16 * 1024 * 1024
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Variables](#variables)

---
### Variable: MAX_SIGNED_MESSAGE_BYTES

```ts
MAX_SIGNED_MESSAGE_BYTES = 174
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Variables](#variables)

---
### Variable: MIN_ENCRYPTED_MESSAGE_BYTES

```ts
MIN_ENCRYPTED_MESSAGE_BYTES = 150
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Variables](#variables)

---
### Variable: MIN_SIGNED_MESSAGE_BYTES

```ts
MIN_SIGNED_MESSAGE_BYTES = 78
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Variables](#variables)

---
### Variable: decrypt

```ts
decrypt = (message: number[], recipient: PrivateKey): number[] => {
    const ciphertext = copyMessageBytes(message, "Encrypted message", MAX_ENCRYPTED_MESSAGE_BYTES, MIN_ENCRYPTED_MESSAGE_BYTES);
    const recipientKey = copyPrivateKey(recipient, "Recipient");
    const reader = new Reader(ciphertext);
    const messageVersion = toHex(reader.read(4));
    if (messageVersion !== VERSION) {
        throw new Error(`Message version mismatch: Expected ${VERSION}, received ${messageVersion}`);
    }
    const sender = PublicKey.fromString(toHex(reader.read(33)));
    const expectedRecipientDER = toHex(reader.read(33));
    const actualRecipientDER = recipientKey.toPublicKey().encode(true, "hex") as string;
    if (expectedRecipientDER !== actualRecipientDER) {
        throw new Error(`The encrypted message expects a recipient public key of ${expectedRecipientDER}, but the provided key is ${actualRecipientDER}`);
    }
    const keyID = toBase64(reader.read(32));
    const encrypted = reader.read(reader.bin.length - reader.pos);
    const invoiceNumber = `2-message encryption-${keyID}`;
    const signingPriv = sender.deriveChild(recipientKey, invoiceNumber);
    const recipientPub = recipientKey.deriveChild(sender, invoiceNumber);
    const sharedSecret = signingPriv.deriveSharedSecret(recipientPub);
    const symmetricKey = new SymmetricKey(sharedSecret.encode(true).slice(1));
    return symmetricKey.decrypt(encrypted) as number[];
}
```

See also: [MAX_ENCRYPTED_MESSAGE_BYTES](./messages.md#variable-max_encrypted_message_bytes), [MIN_ENCRYPTED_MESSAGE_BYTES](./messages.md#variable-min_encrypted_message_bytes), [PrivateKey](./primitives.md#class-privatekey), [PublicKey](./primitives.md#class-publickey), [Reader](./primitives.md#class-reader), [SymmetricKey](./primitives.md#class-symmetrickey), [copyMessageBytes](./messages.md#function-copymessagebytes), [copyPrivateKey](./messages.md#function-copyprivatekey), [encode](./primitives.md#variable-encode), [string](./remittance.md#function-string), [toBase64](./primitives.md#function-tobase64), [toHex](./primitives.md#variable-tohex)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Variables](#variables)

---
### Variable: encrypt

```ts
encrypt = (message: number[], sender: PrivateKey, recipient: PublicKey): number[] => {
    const plaintext = copyMessageBytes(message, "Message");
    const senderKey = copyPrivateKey(sender, "Sender");
    const recipientKey = copyPublicKey(recipient, "Recipient");
    const keyID = Random(32);
    const keyIDBase64 = toBase64(keyID);
    const invoiceNumber = `2-message encryption-${keyIDBase64}`;
    const signingPriv = senderKey.deriveChild(recipientKey, invoiceNumber);
    const recipientPub = recipientKey.deriveChild(senderKey, invoiceNumber);
    const sharedSecret = signingPriv.deriveSharedSecret(recipientPub);
    const symmetricKey = new SymmetricKey(sharedSecret.encode(true).slice(1));
    const encrypted = symmetricKey.encrypt(plaintext) as number[];
    const senderPublicKey = senderKey.toPublicKey().encode(true);
    const version = toArray(VERSION, "hex");
    return version.concat(senderPublicKey, recipientKey.encode(true), keyID, encrypted);
}
```

See also: [PrivateKey](./primitives.md#class-privatekey), [PublicKey](./primitives.md#class-publickey), [SymmetricKey](./primitives.md#class-symmetrickey), [copyMessageBytes](./messages.md#function-copymessagebytes), [copyPrivateKey](./messages.md#function-copyprivatekey), [copyPublicKey](./messages.md#function-copypublickey), [encode](./primitives.md#variable-encode), [toArray](./primitives.md#variable-toarray), [toBase64](./primitives.md#function-tobase64)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Variables](#variables)

---
### Variable: sign

```ts
sign = (message: number[], signer: PrivateKey, verifier?: PublicKey): number[] => {
    const plaintext = copyMessageBytes(message, "Message");
    const signerKey = copyPrivateKey(signer, "Signer");
    const recipientAnyone = verifier === undefined;
    let verifierKey: PublicKey;
    if (recipientAnyone) {
        verifierKey = new PrivateKey(1).toPublicKey();
    }
    else {
        verifierKey = copyPublicKey(verifier, "Verifier");
    }
    const keyID = Random(32);
    const keyIDBase64 = toBase64(keyID);
    const invoiceNumber = `2-message signing-${keyIDBase64}`;
    const signingKey = signerKey.deriveChild(verifierKey, invoiceNumber);
    const signature = signingKey.sign(plaintext).toDER() as number[];
    const senderPublicKey = signerKey.toPublicKey().encode(true);
    const version = toArray(VERSION, "hex");
    return version.concat(senderPublicKey, recipientAnyone ? [0] : verifierKey.encode(true), keyID, signature);
}
```

See also: [PrivateKey](./primitives.md#class-privatekey), [PublicKey](./primitives.md#class-publickey), [copyMessageBytes](./messages.md#function-copymessagebytes), [copyPrivateKey](./messages.md#function-copyprivatekey), [copyPublicKey](./messages.md#function-copypublickey), [encode](./primitives.md#variable-encode), [toArray](./primitives.md#variable-toarray), [toBase64](./primitives.md#function-tobase64)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Variables](#variables)

---
### Variable: verify

```ts
verify = (message: number[], sig: number[], recipient?: PrivateKey): boolean => {
    const plaintext = copyMessageBytes(message, "Message");
    const signatureBytes = copyMessageBytes(sig, "Signed message", MAX_SIGNED_MESSAGE_BYTES, MIN_SIGNED_MESSAGE_BYTES);
    const reader = new Reader(signatureBytes);
    const messageVersion = toHex(reader.read(4));
    if (messageVersion !== VERSION) {
        throw new Error(`Message version mismatch: Expected ${VERSION}, received ${messageVersion}`);
    }
    const signer = PublicKey.fromString(toHex(reader.read(33)));
    const [verifierFirst] = reader.read(1);
    let recipientKey: PrivateKey;
    if (verifierFirst === 0) {
        recipientKey = new PrivateKey(1);
    }
    else {
        const verifierRest = reader.read(32);
        const verifierDER = toHex([verifierFirst, ...verifierRest]);
        if (recipient === undefined) {
            throw new TypeError(`This signature can only be verified with knowledge of a specific private key. The associated public key is: ${verifierDER}`);
        }
        recipientKey = copyPrivateKey(recipient, "Recipient");
        const recipientDER = recipientKey.toPublicKey().encode(true, "hex") as string;
        if (verifierDER !== recipientDER) {
            throw new Error(`The recipient public key is ${recipientDER} but the signature requres the recipient to have public key ${verifierDER}`);
        }
    }
    const keyID = toBase64(reader.read(32));
    const signatureDER = toHex(reader.read(reader.bin.length - reader.pos));
    const signature = Signature.fromDER(signatureDER, "hex");
    const invoiceNumber = `2-message signing-${keyID}`;
    const signingKey = signer.deriveChild(recipientKey, invoiceNumber);
    return signingKey.verify(plaintext, signature) === true;
}
```

See also: [MAX_SIGNED_MESSAGE_BYTES](./messages.md#variable-max_signed_message_bytes), [MIN_SIGNED_MESSAGE_BYTES](./messages.md#variable-min_signed_message_bytes), [PrivateKey](./primitives.md#class-privatekey), [PublicKey](./primitives.md#class-publickey), [Reader](./primitives.md#class-reader), [Signature](./primitives.md#class-signature), [copyMessageBytes](./messages.md#function-copymessagebytes), [copyPrivateKey](./messages.md#function-copyprivatekey), [encode](./primitives.md#variable-encode), [string](./remittance.md#function-string), [toBase64](./primitives.md#function-tobase64), [toHex](./primitives.md#variable-tohex)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Variables](#variables)

---
