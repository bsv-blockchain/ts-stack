#!/usr/bin/env python3
"""Independent stdlib RFC 7578 reader, wire writer, and BRC-104 preimage oracle.

Run without arguments to verify the checked-in corpus. --write regenerates it.
This is an independent fixture oracle, not a claimed external wallet integration.
"""
import base64
import json
import struct
import sys
from email import policy
from email.parser import BytesParser
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
DESTINATION = ROOT / 'conformance/vectors/payments/brc118.json'
REVISION = '2b959b13f1f73040d13cc4eb14edbfc376f8010b'
BOUNDARY = '----BsvPayment00112233445566778899aabbccddeeff'
PAYMENT = '{"derivationPrefix":"AA==","derivationSuffix":"AQ==","transaction":"AQID"}'


def varint(number):
    if number < 0:
        return b'\xff' + struct.pack('<Q', (1 << 64) + number)
    if number < 253:
        return bytes([number])
    if number <= 65535:
        return b'\xfd' + struct.pack('<H', number)
    if number <= 4294967295:
        return b'\xfe' + struct.pack('<I', number)
    return b'\xff' + struct.pack('<Q', number)


def field(value):
    value = value.encode('utf-8') if isinstance(value, str) else value
    return varint(len(value) if value else -1) + value


def vector(name, payload, media_type=None, quoted=False):
    prefix = ('--' + BOUNDARY + '\r\nContent-Disposition: form-data; name="x-bsv-payment"'
              '\r\nContent-Type: application/json\r\n\r\n').encode('ascii')
    wire = prefix + PAYMENT.encode('utf-8')
    if payload is not None:
        wire += ('\r\n--' + BOUNDARY + '\r\nContent-Disposition: form-data; name="body"'
                 '\r\nContent-Type: ' + media_type + '\r\n\r\n').encode('ascii') + payload
    wire += ('\r\n--' + BOUNDARY + '--\r\n').encode('ascii')
    content_type = 'multipart/form-data; boundary=' + ('"' + BOUNDARY + '"' if quoted else BOUNDARY)
    # Python's standard MIME parser is independent of both TS writer and parser.
    message = BytesParser(policy=policy.default).parsebytes(
        ('MIME-Version: 1.0\r\nContent-Type: ' + content_type + '\r\n\r\n').encode('ascii') + wire)
    parts = list(message.iter_parts())
    assert not message.defects and len(parts) == (1 if payload is None else 2)
    assert parts[0].get_param('name', header='content-disposition') == 'x-bsv-payment'
    assert parts[0].get_payload(decode=True) == PAYMENT.encode('utf-8')
    if payload is not None:
        assert parts[1].get_param('name', header='content-disposition') == 'body'
        # Nested multipart payloads are deliberately opaque to BRC-118.
        if not media_type.startswith('multipart/'):
            assert parts[1].get_payload(decode=True) == payload
    headers = {'authorization': 'Bearer conformance-fixture', 'content-type': content_type, 'x-bsv-example': 'fixture'}
    nonce = bytes(range(32))
    preimage = nonce + field('POST') + field('/paid') + field('?q=%E9%9B%AA&order=1') + varint(len(headers))
    for key, value in sorted(headers.items()):
        preimage += field(key) + field(value)
    preimage += field(wire)
    return {
        'id': 'payments.brc118.' + name,
        'description': 'Exact multipart bytes and authenticated preimage: ' + name,
        'input': {'payment_json': PAYMENT, 'boundary': BOUNDARY, 'quoted_boundary': quoted,
                  'payload_base64': None if payload is None else base64.b64encode(payload).decode(),
                  'payload_content_type': media_type, 'method': 'POST', 'path': '/paid',
                  'query': '?q=%E9%9B%AA&order=1', 'request_id_hex': nonce.hex(), 'headers': headers},
        'expected': {'body_base64': base64.b64encode(wire).decode(), 'content_type': content_type,
                     'request_preimage_hex': preimage.hex()},
        'tags': ['brc-118', 'exact-bytes', 'independent-python-oracle']
    }


corpus = {
    '$schema': '../../schema/vector.schema.json', 'id': 'payments.brc118',
    'name': 'BRC-118 Multipart Transport and BRC-104 Request Preimages', 'version': '1.0.0',
    'brc': ['BRC-104', 'BRC-105', 'BRC-118'], 'reference_impl': '@bsv/sdk; independent Python stdlib oracle',
    'parity_class': 'required',
    'notes': 'Reviewed BRCs commit ' + REVISION + '; peer-to-peer/0104.md, payments/0105.md, payments/0118.md. Payment fields are synthetic transport bytes, not a spendable transaction. Non-multipart released signature preimages remain unchanged.',
    'vectors': [vector('json-whitespace-utf8', '{ "snow": "雪" }\n'.encode(), 'application/json; charset=utf-8'),
                vector('binary-nul', bytes([0, 128, 255, 13, 10, 0]), 'application/octet-stream'),
                vector('empty', b'', 'text/plain'), vector('absent', None),
                vector('nested-multipart', b'--inner\r\nContent-Disposition: form-data; name="field"\r\n\r\nvalue\r\n--inner--\r\n', 'multipart/form-data; boundary=inner'),
                vector('quoted-boundary', b'quoted', 'text/plain', True)]
}

if '--write' in sys.argv:
    DESTINATION.write_text(json.dumps(corpus, indent=2, ensure_ascii=False) + '\n')
else:
    assert json.loads(DESTINATION.read_text()) == corpus, 'BRC-118 corpus differs from independent oracle'
print(f'Verified {len(corpus["vectors"])} independent BRC-118 wire/preimage vectors at BRCs {REVISION}')
