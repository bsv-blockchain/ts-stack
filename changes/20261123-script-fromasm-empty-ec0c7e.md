---
release:
  "@bsv/sdk": patch
  "@bsv/wallet-helper": patch
---
Script.fromASM('') returns the empty script, so fromASM(toASM(script)) holds for a script with no chunks. An empty token from a leading, trailing or repeated space throws 'invalid ASM: empty token' instead of inserting an empty push. toASM() writes a zero-length push, including a non-minimal OP_PUSHDATA of length 0, as OP_0. In @bsv/wallet-helper, addOpReturnData writes an empty field as OP_0; the script bytes are unchanged.

## Migration

Valid single-spaced ASM needs no migration. A caller that used a blank ASM token as an empty push must write OP_0, OP_FALSE or 0.
