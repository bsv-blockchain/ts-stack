# Regression Vector Queue

Issues that were reviewed but could not be converted to deterministic vectors due to insufficient detail in the issue body. Each entry notes what additional information is needed.

| Issue | Title | Needs |
|-------|-------|-------|
| ts-sdk#203 | Resource Exhaustion in Script Interpreter | No deterministic expected output — the issue describes a DoS via exponential stack growth but does not specify a memory limit or error message that implementations must produce. Need: agreed policy limit (bytes) and required error string. |
| ts-sdk#109 | Script template length estimate doesn't account for larger signatures | Not a crypto/encoding bug — affects only fee estimation heuristics in RPuzzle template. No expected output. Need: concrete expected unlock script max size (73 bytes instead of 71). |
| ts-sdk#241 | Negative number handling in wallet wire encoding | WalletWire is an application-layer substrate, not a Tier 0 crypto/tx path. No cross-language parity impact. Need: wire encoding spec to derive deterministic expected hex. |
| go-sdk#211 | BEEF IsValid/Verify algorithm is unstable — gives different results for the same input | The instability stems from map iteration order in Go (non-deterministic), not from a wrong output for a known input. A deterministic vector cannot capture this race condition. Need: a unit test not a conformance vector. |
| go-sdk#96 | BEEF decode error: "There are no leaves at height" | The BUMP hex in the issue is a complex real-world payload. The error is in the Merkle proof decoder for an uncommon tree shape. Need: a minimal reduced BUMP hex that triggers the edge case, plus the correct parsed leaf count at each height. |
| go-sdk#74 | BEEF generated from complex tree cannot be parsed back to sdk.Transaction | Issue body contains only Go test code with embedded BEEF hex blobs, no expected TxIDs or verification results. Need: expected TxID of the final spending transaction to write a deterministic check. |
| ts-sdk#371 | Sequence Number 0 gets reset to MAX | The issue is fully described but the fix is SDK-internal (don't overwrite missing sequence with default during array-literal construction). The regression vector (tx-sequence-zero-sighash) covers the observable behaviour. Captured — no further action needed here. |
| ts-sdk#54 | OP_IF OP_RETURN terminates early — script eval error | The issue shows that OP_IF + OP_1 + OP_RETURN + OP_ENDIF should return true, but no txid or script hex with known valid CHECKSIG is given. Would require adding to sdk/scripts/evaluation.json rather than a regression file. Deferred to evaluation vector set. |
| go-sdk#261 | Go-SDK cannot process transactions which generate large data items on stack | Script template provided uses NUM2BIN with a 10 MB argument. No expected pass/fail outcome is specified — just that it "should validate successfully". Need: exact script hex and whether the script passes or returns a specific error. |
| ts-sdk#259 | PushDrop.parse doesn't support lockPosition='after' | Parser bug in application-layer template, not in core tx/crypto path. Insufficient inputs (no example token locking script hex + expected field parse output). |
