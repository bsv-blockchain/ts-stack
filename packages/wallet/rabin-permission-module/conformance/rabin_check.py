#!/usr/bin/env python3
"""Independent BRC-206 checker.

Reproduces Rabin factors and canonical signatures from the 32-byte BRC-42 seed
alone. The algorithm matches packages/wallet/rabin-permission-module/src.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import sys

SALT = b"BRC-206 p rabin v1"
PADDING_LIMIT = 65536
TRIAL_LIMIT = 4096
MAX_CANDIDATES = 8192
WITNESSES = [2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53]


def hmac_sha256(key: bytes, data: bytes) -> bytes:
    return hmac.new(key, data, hashlib.sha256).digest()


def hkdf_extract(salt: bytes, ikm: bytes) -> bytes:
    return hmac_sha256(salt, ikm)


def hkdf_expand(prk: bytes, info: bytes, length: int) -> bytes:
    out = b""
    previous = b""
    counter = 1
    while len(out) < length:
        previous = hmac_sha256(prk, previous + info + bytes([counter]))
        out += previous
        counter += 1
    return out[:length]


def sieve(limit: int) -> list[int]:
    composite = bytearray(limit + 1)
    primes: list[int] = []
    for value in range(2, limit + 1):
        if composite[value]:
            continue
        primes.append(value)
        step = value
        multiple = value * value
        while multiple <= limit:
            composite[multiple] = 1
            multiple += step
    return primes


TRIAL_PRIMES = sieve(TRIAL_LIMIT)


def passes_trial_division(value: int) -> bool:
    for prime in TRIAL_PRIMES:
        if value == prime:
            return True
        if value % prime == 0:
            return False
    return True


def split_twos(even: int) -> tuple[int, int]:
    odd = even
    powers = 0
    while odd % 2 == 0:
        odd //= 2
        powers += 1
    return odd, powers


def witness_accepts(value: int, odd: int, powers: int, witness: int) -> bool:
    base = witness % value
    if base == 0:
        return True
    power = pow(base, odd, value)
    if power == 1 or power == value - 1:
        return True
    for _ in range(powers - 1):
        power = pow(power, 2, value)
        if power == value - 1:
            return True
        if power == 1:
            return False
    return False


def is_probable_prime(value: int) -> bool:
    if value < 2 or not passes_trial_division(value):
        return False
    odd, powers = split_twos(value - 1)
    for witness in WITNESSES:
        if not witness_accepts(value, odd, powers, witness):
            return False
    return True


def force_prime_shape(block: bytes) -> int:
    shaped = bytearray(block)
    shaped[0] |= 0xC0
    shaped[-1] |= 0x03
    return int.from_bytes(shaped, "big")


def next_prime(prk: bytes, modulus_bits: int, prime_index: int) -> int:
    prime_bits = modulus_bits // 2
    byte_length = prime_bits // 8
    for counter in range(MAX_CANDIDATES):
        info = f"p rabin|key|{modulus_bits}|prime|{prime_index}|ctr|{counter}".encode()
        candidate = force_prime_shape(hkdf_expand(prk, info, byte_length))
        if (
            candidate.bit_length() == prime_bits
            and candidate % 4 == 3
            and is_probable_prime(candidate)
        ):
            return candidate
    raise SystemExit("prime search exceeded 8192 candidates")


def derive_factors(seed: bytes, bits: int) -> tuple[int, int, int]:
    if len(seed) != 32:
        raise SystemExit("seed must be 32 bytes")
    if bits not in (2048, 3072, 4096):
        raise SystemExit("modulus size must be 2048, 3072, or 4096")
    prk = hkdf_extract(SALT, seed)
    first = next_prime(prk, bits, 0)
    second = next_prime(prk, bits, 1)
    if first == second:
        raise SystemExit("degenerate prime pair")
    if first > second:
        first, second = second, first
    modulus = first * second
    if modulus.bit_length() != bits:
        raise SystemExit("modulus does not have the requested width")
    return first, second, modulus


def is_quadratic_residue(value: int, prime: int) -> bool:
    reduced = value % prime
    if reduced == 0:
        return True
    return pow(reduced, (prime - 1) // 2, prime) == 1


def principal_crt_root(root_p: int, p: int, root_q: int, q: int) -> int:
    modulus = p * q
    inverse_q = pow(q, p - 2, p)
    inverse_p = pow(p, q - 2, q)
    return (root_p * q * inverse_q + root_q * p * inverse_p) % modulus


def rabin_sign(message: bytes, p: int, q: int) -> tuple[int, int, int]:
    if p >= q:
        raise SystemExit("primes must satisfy p < q")
    modulus = p * q
    digest = int.from_bytes(hashlib.sha256(message).digest(), "little")
    hash_mod = digest % modulus
    for padding in range(PADDING_LIMIT):
        target = (hash_mod - padding) % modulus
        if not is_quadratic_residue(target, p) or not is_quadratic_residue(target, q):
            continue
        signature = principal_crt_root(
            pow(target, (p + 1) // 4, p),
            p,
            pow(target, (q + 1) // 4, q),
            q,
        )
        if (signature * signature + padding) % modulus != hash_mod:
            raise SystemExit("principal CRT root failed verification")
        return signature, padding, modulus
    raise SystemExit("no padding below 65536 makes the digest a quadratic residue")


def encode_script_number(value: int) -> bytes:
    if value < 0:
        raise SystemExit("script numbers are non-negative")
    if value == 0:
        return b""
    out = bytearray()
    remaining = value
    while remaining:
        out.append(remaining & 0xFF)
        remaining >>= 8
    if out[-1] & 0x80:
        out.append(0)
    return bytes(out)


def encode_push(data: bytes) -> bytes:
    if len(data) == 1 and 1 <= data[0] <= 16:
        return bytes([0x50 + data[0]])
    if data == b"\x81":
        return bytes([0x4F])
    length = len(data)
    if length < 76:
        return bytes([length]) + data
    if length <= 255:
        return bytes([0x4C, length]) + data
    if length <= 65535:
        return bytes([0x4D, length & 0xFF, (length >> 8) & 0xFF]) + data
    raise SystemExit("script push exceeds PUSHDATA2")


def ciphertext_hex(signature: int, padding: int) -> str:
    return (encode_push(encode_script_number(signature)) + encode_push(encode_script_number(padding))).hex()


def key_ciphertext_hex(modulus: int) -> str:
    return encode_push(encode_script_number(modulus)).hex()


# The checker reads and writes only this file. A caller-supplied path is not accepted.
VECTORS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "vectors.json")


def require(condition: bool, message: str) -> None:
    if not condition:
        raise SystemExit(message)


def check_signature(key_id: str, p: int, q: int, signature: dict) -> None:
    got_sig, got_pad, _ = rabin_sign(bytes.fromhex(signature["messageHex"]), p, q)
    require(
        got_sig == int(signature["sigHex"], 16) and got_pad == signature["padding"],
        f"signature mismatch for {key_id} {signature['messageHex']}",
    )
    require(
        ciphertext_hex(got_sig, got_pad) == signature["ciphertextHex"],
        f"signature ciphertext mismatch for {key_id}",
    )
    require(
        encode_script_number(got_pad).hex() == signature["paddingScriptHex"],
        f"padding encoding mismatch for {key_id}",
    )


def check_key(key: dict) -> None:
    p, q, modulus = derive_factors(bytes.fromhex(key["seedHex"]), key["bits"])
    require(
        f"{p:x}" == key["pHex"] and f"{q:x}" == key["qHex"] and f"{modulus:x}" == key["nHex"],
        f"factor mismatch for {key['id']}",
    )
    require(
        key_ciphertext_hex(modulus) == key["keyCiphertextHex"],
        f"key ciphertext mismatch for {key['id']}",
    )
    for signature in key["signatures"]:
        check_signature(key["id"], p, q, signature)


def check_padding_encodings(rows: list) -> None:
    for row in rows:
        require(
            encode_script_number(row["value"]).hex() == row["scriptHex"],
            f"padding encoding mismatch for {row['value']}",
        )


def check_vectors() -> None:
    with open(VECTORS, encoding="utf-8") as handle:
        document = json.load(handle)
    require(document.get("salt") == SALT.decode(), "salt mismatch")
    for key in document["keys"]:
        check_key(key)
    check_padding_encodings(document["paddingEncodings"])
    print(f"checked {len(document['keys'])} keys")


def check_seed(seed_hex: str, bits: int, message_hex: str) -> None:
    p, q, modulus = derive_factors(bytes.fromhex(seed_hex), bits)
    signature, padding, _ = rabin_sign(bytes.fromhex(message_hex), p, q)
    print(
        json.dumps(
            {
                "pHex": f"{p:x}",
                "qHex": f"{q:x}",
                "nHex": f"{modulus:x}",
                "sigHex": f"{signature:x}",
                "padding": padding,
            }
        )
    )


def generate_vectors() -> None:
    messages = [b"", b"rabin", bytes(range(32))]
    document = {
        "salt": SALT.decode(),
        "equation": "(signature^2 + padding) mod n == int.from_bytes(SHA-256(message), 'little')",
        "paddingEncodings": [
            {"value": value, "scriptHex": encode_script_number(value).hex()}
            for value in (0, 1, 127, 128, 255, 256, 65535)
        ],
        "keys": [],
    }
    for bits, seed_byte in ((2048, 0x11), (3072, 0x22), (4096, 0x33)):
        seed = bytes([seed_byte]) * 32
        print(f"deriving {bits}", flush=True)
        p, q, modulus = derive_factors(seed, bits)
        signatures = []
        for message in messages:
            signature, padding, _ = rabin_sign(message, p, q)
            signatures.append(
                {
                    "messageHex": message.hex(),
                    "sigHex": f"{signature:x}",
                    "padding": padding,
                    "paddingScriptHex": encode_script_number(padding).hex(),
                    "ciphertextHex": ciphertext_hex(signature, padding),
                }
            )
        document["keys"].append(
            {
                "id": f"rabin-{bits}",
                "bits": bits,
                "seedHex": seed.hex(),
                "pHex": f"{p:x}",
                "qHex": f"{q:x}",
                "nHex": f"{modulus:x}",
                "keyCiphertextHex": key_ciphertext_hex(modulus),
                "signatures": signatures,
            }
        )
        print(f"derived {bits} padding={[row['padding'] for row in signatures]}", flush=True)
    with open(VECTORS, "w", encoding="utf-8") as handle:
        json.dump(document, handle, indent=2)
        handle.write("\n")


def main() -> None:
    if sys.argv[1:] == ["--vectors"]:
        check_vectors()
        return
    if sys.argv[1:] == ["--generate"]:
        generate_vectors()
        return
    if len(sys.argv) == 5 and sys.argv[1] == "--seed":
        check_seed(sys.argv[2], int(sys.argv[3]), sys.argv[4])
        return
    raise SystemExit(
        "usage: rabin_check.py --vectors | --generate | --seed <hex> <bits> <messageHex>"
    )


if __name__ == "__main__":
    main()
