/**
 * URL authorities (host[:port]) for loopback hosts, which may always use plain
 * http:/ws:. Entries are written as a developer might type them; the WHATWG URL
 * parser normalises case, integer/hex IPv4 forms, and trailing IPv4 dots.
 */
export const LOOPBACK_AUTHORITIES = [
  'localhost:3000',
  'LOCALHOST',
  'wallet.localhost:3000',
  '127.0.0.1:3000',
  '127.8.9.10',
  '0x7f.1', // 127.0.0.1
  '[::1]:3000',
  '[0:0:0:0:0:0:0:1]'
] as const

/** Private-network IP authorities that need `allowLocalNetworkHttp` for plain http:/ws:. */
export const LOCAL_NETWORK_AUTHORITIES = [
  '10.0.0.1',
  '10.255.255.255:3000',
  '10.0.0.1.',
  '172.16.0.1',
  '172.31.255.254:3000',
  '192.168.0.1',
  '192.168.1.20:3000',
  '3232235777', // 192.168.1.1
  '[fc00::]',
  '[fc00::1]:3000',
  '[FD12:3456:789a::1]',
  '[fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff]'
] as const

/** URL authorities that must keep requiring https:/wss:. */
export const PUBLIC_AUTHORITIES = [
  'relay.example',
  '8.8.8.8',
  '134744072', // 8.8.8.8
  '0.0.0.0',
  '9.255.255.255',
  '11.0.0.1',
  '126.255.255.255',
  '128.0.0.1',
  '172.15.255.255',
  '172.32.0.1',
  '192.167.255.255',
  '192.169.0.1',
  '100.64.0.1',
  '169.254.1.1',
  '[::]',
  '[::2]',
  '[fbff::1]',
  '[fc0::1]', // 0fc0::/16, outside fc00::/7
  '[fd0::1]',
  '[fe00::1]',
  '[fe80::1]',
  '[2001:db8::1]',
  '[::ffff:192.168.1.1]',
  '[::ffff:127.0.0.1]',
  'localhost.',
  'localhost.example.com',
  'printer.local',
  '192.168.1.20.nip.io',
  '192.168.1.1.example.com',
  '10.0.0.1.example.com',
  'fc00.example.com'
] as const
