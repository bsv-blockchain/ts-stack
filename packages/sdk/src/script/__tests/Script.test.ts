import Script from '../../script/Script'
import PrivateKey from '../../primitives/PrivateKey'
import P2PKH from '../../script/templates/P2PKH'
import OP from '../../script/OP'
import { toHex } from '../../primitives/utils'

import scriptInvalid from './script.invalid.vectors'
import scriptValid from './script.valid.vectors'

describe('Script', () => {
  it('should make a new script', () => {
    const script = new Script()
    expect(script).toBeDefined()
    expect(new Script().toASM()).toEqual('')
  })

  describe('fromHex', () => {
    it('should parse this hex string containing an OP code', () => {
      const buf = Buffer.alloc(1)
      buf[0] = OP.OP_0
      const script = Script.fromHex(buf.toString('hex'))
      expect(script.chunks).toHaveLength(1)
      expect(script.chunks[0].op).toBe(buf[0])
    })
  })

  describe('fromAddress', () => {
    it('should parse this mainnet Base58Check encoded address string and result in a P2PKH Script', () => {
      const priv = PrivateKey.fromRandom()
      const address = priv.toAddress()
      const publicKey = priv.toPublicKey()
      const pkh = publicKey.toHash()
      const lockingScriptFromTemplate = new P2PKH().lock(pkh).toASM()
      const script = new P2PKH().lock(address).toASM()
      expect(script).toBe(lockingScriptFromTemplate)
    })

    it('should parse this testnet Base58Check encoded address string and result in a P2PKH Script', () => {
      const priv = PrivateKey.fromRandom()
      const address = priv.toAddress([0x6f])
      const publicKey = priv.toPublicKey()
      const pkh = publicKey.toHash()
      const lockingScriptFromTemplate = new P2PKH().lock(pkh).toASM()
      const script = new P2PKH().lock(address).toASM()
      expect(script).toBe(lockingScriptFromTemplate)
    })

    it('should error when attempting to parse this strange Base58Check encoded string', () => {
      const priv = PrivateKey.fromRandom()
      const address = priv.toAddress([0x88])
      function attemptToDeriveAddress(): string {
        const script = new P2PKH().lock(address).toASM()
        return script
      }
      expect(attemptToDeriveAddress).toThrow('only P2PKH is supported')
    })
  })

  describe('fromBinary', () => {
    it('should parse this buffer containing an OP code', () => {
      const buf = Buffer.alloc(1)
      buf[0] = OP.OP_0
      const script = Script.fromBinary([...buf])
      expect(script.chunks).toHaveLength(1)
      expect(script.chunks[0].op).toBe(buf[0])
    })

    it('should parse this buffer containing another OP code', () => {
      const buf = Buffer.alloc(1)
      buf[0] = OP.OP_CHECKMULTISIG
      const script = Script.fromBinary([...buf])
      expect(script.chunks).toHaveLength(1)
      expect(script.chunks[0].op).toBe(buf[0])
    })

    it('should parse this buffer containing three bytes of data', () => {
      const buf = [3, 1, 2, 3]
      const script = Script.fromBinary([...buf])
      expect(script.chunks).toHaveLength(1)
      expect(script.chunks[0].data).toEqual([1, 2, 3])
    })

    it('should parse this buffer containing OP_PUSHDATA1 and zero bytes of data', () => {
      const buf = [0]
      buf[0] = OP.OP_PUSHDATA1
      const script = Script.fromBinary([...buf])
      expect(script.chunks).toHaveLength(1)
      expect(script.chunks[0].data).toEqual([])
    })

    it('should parse this buffer containing OP_PUSHDATA2 and zero bytes of data', () => {
      const buf = [0]
      buf[0] = OP.OP_PUSHDATA2
      const script = Script.fromBinary([...buf])
      expect(script.chunks).toHaveLength(1)
      expect(script.chunks[0].data).toEqual([])
    })

    it('should parse this buffer containing OP_PUSHDATA2 and three bytes of data', () => {
      const buf = [OP.OP_PUSHDATA2, 3, 0, 1, 2, 3]
      const script = Script.fromBinary([...buf])
      expect(script.chunks).toHaveLength(1)
      expect(script.chunks[0].data).toEqual([1, 2, 3])
    })

    it('should parse this buffer containing OP_PUSHDATA4 and zero bytes of data', () => {
      const buf = [0, 0]
      buf[0] = OP.OP_PUSHDATA4
      const script = Script.fromBinary([...buf])
      expect(script.chunks).toHaveLength(1)
      expect(script.chunks[0].data).toEqual([])
    })

    it('should parse this buffer containing OP_PUSHDATA4 and three bytes of data', () => {
      const buf = [OP.OP_PUSHDATA4, 3, 0, 0, 0, 1, 2, 3]
      const script = Script.fromBinary([...buf])
      expect(script.chunks).toHaveLength(1)
      expect(script.chunks[0].data).toEqual([1, 2, 3])
    })

    it('should parse this buffer an OP code, data, and another OP code', () => {
      const buf = [OP.OP_0, OP.OP_PUSHDATA4, 3, 0, 0, 0, 1, 2, 3, OP.OP_0]
      const script = Script.fromBinary([...buf])
      expect(script.chunks).toHaveLength(3)
      expect(script.chunks[0].op).toEqual(buf[0])
      expect(script.chunks[1].data).toEqual([1, 2, 3])
      expect(script.chunks[2].op).toEqual(buf[buf.length - 1])
    })

    it('should output this hex string containing an OP code', () => {
      const buf = Buffer.alloc(1)
      buf[0] = OP.OP_0
      const script = Script.fromHex(buf.toString('hex'))
      expect(script.chunks).toHaveLength(1)
      expect(script.chunks[0].op).toEqual(buf[0])
      expect(script.toHex()).toEqual(buf.toString('hex'))
    })

    it('should output this buffer containing an OP code', () => {
      const buf = Buffer.alloc(1)
      buf[0] = OP.OP_0
      const script = Script.fromBinary([...buf])
      expect(script.chunks).toHaveLength(1)
      expect(script.chunks[0].op).toEqual(buf[0])
      expect(script.toHex()).toEqual(buf.toString('hex'))
    })

    it('should output this buffer containing another OP code', () => {
      const buf = Buffer.alloc(1)
      buf[0] = OP.OP_CHECKMULTISIG
      const script = Script.fromBinary([...buf])
      expect(script.chunks).toHaveLength(1)
      expect(script.chunks[0].op).toEqual(buf[0])
      expect(script.toHex()).toEqual(buf.toString('hex'))
    })

    it('should output this buffer containing three bytes of data', () => {
      const buf = Buffer.from([3, 1, 2, 3])
      const script = Script.fromBinary([...buf])
      expect(script.chunks).toHaveLength(1)
      expect(script.chunks[0].data).toEqual([1, 2, 3])
      expect(script.toHex()).toEqual(buf.toString('hex'))
    })

    it('should output this buffer containing OP_PUSHDATA1 and three bytes of data', () => {
      const buf = Buffer.from([0, 0, 1, 2, 3])
      buf[0] = OP.OP_PUSHDATA1
      buf.writeUInt8(3, 1)
      const script = Script.fromBinary([...buf])
      expect(script.chunks).toHaveLength(1)
      expect(script.chunks[0].data).toEqual([1, 2, 3])
      expect(script.toHex()).toEqual(buf.toString('hex'))
    })

    it('should output this buffer containing OP_PUSHDATA2 and three bytes of data', () => {
      const buf = Buffer.from([0, 0, 0, 1, 2, 3])
      buf[0] = OP.OP_PUSHDATA2
      buf.writeUInt16LE(3, 1)
      const script = Script.fromBinary([...buf])
      expect(script.chunks).toHaveLength(1)
      expect(script.chunks[0].data).toEqual([1, 2, 3])
      expect(script.toHex()).toEqual(buf.toString('hex'))
    })

    it('should output this buffer containing OP_PUSHDATA4 and three bytes of data', () => {
      const buf = Buffer.from([0, 0, 0, 0, 0, 1, 2, 3])
      buf[0] = OP.OP_PUSHDATA4
      buf.writeUInt16LE(3, 1)
      const script = Script.fromBinary([...buf])
      expect(script.chunks).toHaveLength(1)
      expect(script.chunks[0].data).toEqual([1, 2, 3])
      expect(script.toHex()).toEqual(buf.toString('hex'))
    })

    it('should output this buffer an OP code, data, and another OP code', () => {
      const buf = Buffer.from([0, 0, 0, 0, 0, 0, 1, 2, 3, 0])
      buf[0] = OP.OP_0
      buf[1] = OP.OP_PUSHDATA4
      buf.writeUInt16LE(3, 2)
      buf[buf.length - 1] = OP.OP_0
      const script = Script.fromBinary([...buf])
      expect(script.chunks).toHaveLength(3)
      expect(script.chunks[0].op).toEqual(buf[0])
      expect(script.chunks[1].data).toEqual([1, 2, 3])
      expect(script.chunks[2].op).toEqual(buf[buf.length - 1])
      expect(script.toHex()).toEqual(buf.toString('hex'))
    })
  })

  describe('toASM', () => {
    it('should output this buffer an OP code, data, and another OP code', () => {
      const buf = Buffer.from([0, 0, 0, 0, 0, 0, 1, 2, 3, 0])
      buf[0] = OP.OP_0
      buf[1] = OP.OP_PUSHDATA4
      buf.writeUInt16LE(3, 2)
      buf[buf.length - 1] = OP.OP_0
      const script = Script.fromBinary([...buf])
      expect(script.chunks).toHaveLength(3)
      expect(script.chunks[0].op).toEqual(buf[0])
      expect(script.chunks[1].data).toEqual([1, 2, 3])
      expect(script.chunks[2].op).toEqual(buf[buf.length - 1])
      expect(script.toASM()).toEqual('OP_0 010203 OP_0')
    })

    it('prints a top-level OP_RETURN so fromASM restores the same bytes', () => {
      const cases = [
        { hex: '6a0568656c6c6f', asm: 'OP_RETURN 68656c6c6f' },
        { hex: '006a0568656c6c6f', asm: 'OP_0 OP_RETURN 68656c6c6f' },
        { hex: '6a', asm: 'OP_RETURN' },
        { hex: '006a', asm: 'OP_0 OP_RETURN' }
      ]
      for (const { hex, asm } of cases) {
        const script = Script.fromHex(hex)
        expect(script.toASM()).toEqual(asm)
        expect(Script.fromASM(script.toASM()).toHex()).toEqual(hex)
      }

      const falseReturn = Script.fromASM('OP_FALSE OP_RETURN 68656c6c6f')
      expect(falseReturn.toHex()).toEqual('006a0568656c6c6f')
      expect(Script.fromASM(falseReturn.toASM()).toHex()).toEqual(falseReturn.toHex())

      const pushes = 'OP_RETURN 026d02 0568656c6c6f'
      const pushHex = Script.fromASM(pushes).toHex()
      const parsed = Script.fromHex(pushHex)
      expect(parsed.chunks).toHaveLength(1)
      expect(parsed.chunks[0].op).toEqual(OP.OP_RETURN)
      expect(parsed.toASM()).toEqual(pushes)
      expect(Script.fromASM(parsed.toASM()).toHex()).toEqual(pushHex)
    })

    it('keeps the entire OP_RETURN suffix when instruction tokens would change its bytes', () => {
      const cases = [
        { hex: '006a02ab', asm: 'OP_0 OP_RETURN 0x02ab' },
        { hex: '006a4c', asm: 'OP_0 OP_RETURN 0x4c' },
        { hex: '006a4d01', asm: 'OP_0 OP_RETURN 0x4d01' },
        { hex: '006a4e020000', asm: 'OP_0 OP_RETURN 0x4e020000' },
        { hex: '006a4c03abcd', asm: 'OP_0 OP_RETURN 0x4c03abcd' },
        { hex: '006a4e02000000ab', asm: 'OP_0 OP_RETURN 0x4e02000000ab' },
        { hex: '6a4c0002ab', asm: 'OP_RETURN 0x4c0002ab' },
        { hex: '6a4c01ab02cd', asm: 'OP_RETURN 0x4c01ab02cd' },
        { hex: '6a4d0100ab4e0100', asm: 'OP_RETURN 0x4d0100ab4e0100' },
        { hex: '6a4c00', asm: 'OP_RETURN 0x4c00' },
        { hex: '6a4c01ab', asm: 'OP_RETURN 0x4c01ab' },
        { hex: '6a0568656c6c6f02ab', asm: 'OP_RETURN 0x0568656c6c6f02ab' },
        { hex: '00636a686a02ab', asm: 'OP_0 OP_IF OP_RETURN OP_ENDIF OP_RETURN 0x02ab' }
      ]
      for (const { hex, asm } of cases) {
        const script = Script.fromHex(hex)
        expect(script.toASM()).toEqual(asm)
        const back = Script.fromASM(script.toASM())
        expect(back.toHex()).toEqual(hex)
        expect(back.toASM()).toEqual(asm)
        expect(back.chunks.map(({ op, data }) => ({ op, data }))).toEqual(
          script.chunks.map(({ op, data }) => ({ op, data }))
        )
      }

      expect(Script.fromHex('006a01ab').toASM()).toEqual('OP_0 OP_RETURN ab')
    })

    it('uses ordinary data tokens at each length boundary for complete shortest push encodings', () => {
      const cases = [
        { prefix: '4b', len: 75 },
        { prefix: '4c4c', len: 76 },
        { prefix: '4cff', len: 255 },
        { prefix: '4d0001', len: 256 },
        { prefix: '4dffff', len: 65535 },
        { prefix: '4e00000100', len: 65536 }
      ]
      for (const { prefix, len } of cases) {
        const data = 'ab'.repeat(len)
        const hex = `006a${prefix}${data}`
        const asm = Script.fromHex(hex).toASM()
        expect(asm).toBe(`OP_0 OP_RETURN ${data}`)
        expect(Script.fromASM(asm).toHex()).toBe(hex)
      }
    })

    it('round-trips every possible one-byte OP_RETURN suffix', () => {
      for (let byte = 0; byte <= 255; byte++) {
        const hex = `006a${byte.toString(16).padStart(2, '0')}`
        const asm = Script.fromHex(hex).toASM()
        expect(Script.fromASM(asm).toHex()).toBe(hex)
      }
    })
  })

  describe('fromASM', () => {
    it('distinguishes raw OP_RETURN suffix bytes from ordinary data pushes', () => {
      expect(Script.fromASM('OP_RETURN 0x02AB').toHex()).toEqual('6a02ab')
      expect(Script.fromASM('OP_RETURN 02ab').toHex()).toEqual('6a0202ab')
      expect(Script.fromASM('OP_RETURN ab 00 OP_0').toHex()).toEqual('6a01ab010000')
    })

    it('requires the raw suffix to be a nonempty final token directly after the first top-level OP_RETURN', () => {
      for (const asm of [
        'OP_RETURN 0x',
        'OP_RETURN 0x0',
        'OP_RETURN 0xzz',
        'OP_RETURN 0X02AB',
        'OP_RETURN 0x02ab OP_1',
        'OP_RETURN ab 0x02ab',
        'OP_RETURN OP_RETURN 0x02ab',
        'OP_IF OP_RETURN 0x02ab',
        'OP_NOTIF OP_RETURN 0x02ab',
        'OP_DUP 0x02ab',
        '0x02ab'
      ]) {
        expect(() => Script.fromASM(asm)).toThrow()
      }
    })

    it('preserves the existing operands and encoding of explicit PUSHDATA instructions', () => {
      for (const { asm, hex } of [
        { asm: 'OP_PUSHDATA1 0x01', hex: '4c00' },
        { asm: 'OP_PUSHDATA2 0x01', hex: '4d0000' },
        { asm: 'OP_PUSHDATA4 0x01', hex: '4e00000000' },
        { asm: 'OP_RETURN OP_PUSHDATA1 0x01', hex: '6a4c00' },
        { asm: 'OP_PUSHDATA1 0x01 ab OP_DROP', hex: '4c01ab75' },
        { asm: 'OP_PUSHDATA1 1 ab OP_DROP', hex: '4c01ab75' },
        { asm: 'OP_PUSHDATA2 1 ab OP_DROP', hex: '4d0100ab75' },
        { asm: 'OP_PUSHDATA4 1 ab OP_DROP', hex: '4e01000000ab75' }
      ]) {
        expect(Script.fromASM(asm).toHex()).toBe(hex)
      }
      expect(() => Script.fromASM('OP_PUSHDATA1 1 0xab')).toThrow()
    })

    it('should parse these known scripts', () => {
      expect(Script.fromASM('OP_0 010203 OP_0').toASM()).toEqual('OP_0 010203 OP_0')
      expect(
        Script.fromASM(
          'OP_DUP OP_HASH160 1451baa3aad777144a0759998a03538018dd7b4b OP_EQUALVERIFY OP_CHECKSIG'
        ).toASM()
      ).toEqual(
        'OP_DUP OP_HASH160 1451baa3aad777144a0759998a03538018dd7b4b OP_EQUALVERIFY OP_CHECKSIG'
      )
      expect(
        Script.fromASM(
          'OP_SHA256 8cc17e2a2b10e1da145488458a6edec4a1fdb1921c2d5ccbc96aa0ed31b4d5f8 OP_EQUALVERIFY OP_DUP OP_HASH160 1451baa3aad777144a0759998a03538018dd7b4b OP_EQUALVERIFY OP_CHECKSIGVERIFY OP_EQUALVERIFY OP_DUP OP_HASH160 1451baa3aad777144a0759998a03538018dd7b4b OP_EQUALVERIFY OP_CHECKSIG'
        ).toASM()
      ).toEqual(
        'OP_SHA256 8cc17e2a2b10e1da145488458a6edec4a1fdb1921c2d5ccbc96aa0ed31b4d5f8 OP_EQUALVERIFY OP_DUP OP_HASH160 1451baa3aad777144a0759998a03538018dd7b4b OP_EQUALVERIFY OP_CHECKSIGVERIFY OP_EQUALVERIFY OP_DUP OP_HASH160 1451baa3aad777144a0759998a03538018dd7b4b OP_EQUALVERIFY OP_CHECKSIG'
      )
      expect(Script.fromASM('OP_0 010203 OP_0').toASM()).toEqual('OP_0 010203 OP_0')
      expect(Script.fromASM('OP_0 010203 OP_0').toASM()).toEqual('OP_0 010203 OP_0')
      expect(Script.fromASM('OP_0 3 010203 OP_0').toASM()).toEqual('OP_0 03 010203 OP_0')
      expect(Script.fromASM('').toASM()).toEqual('')
    })

    it('reads an empty ASM string as the empty script', () => {
      const empty = new Script()
      const parsed = Script.fromASM('')
      expect(parsed.chunks).toEqual([])
      expect(parsed.toHex()).toEqual('')
      expect(parsed.toASM()).toEqual('')

      const roundTrip = Script.fromASM(empty.toASM())
      expect(roundTrip.chunks).toEqual([])
      expect(roundTrip.toHex()).toEqual(empty.toHex())
      expect(roundTrip.toASM()).toEqual(empty.toASM())
    })

    it('rejects an empty ASM token instead of inserting an empty push', () => {
      const emptyToken = /invalid ASM: empty token/
      expect(() => Script.fromASM('OP_DUP  OP_HASH160')).toThrow(emptyToken)
      expect(() => Script.fromASM(' OP_1')).toThrow(emptyToken)
      expect(() => Script.fromASM('OP_1 ')).toThrow(emptyToken)
      expect(() => Script.fromASM('OP_1   OP_2')).toThrow(emptyToken)
      expect(() => Script.fromASM(' ')).toThrow(emptyToken)
      expect(() => Script.fromASM('OP_PUSHDATA1  01')).toThrow(emptyToken)
      expect(() => Script.fromASM('OP_PUSHDATA1 1 ')).toThrow(emptyToken)
    })

    it('still reads an explicit empty push', () => {
      expect(Script.fromASM('OP_0').chunks).toHaveLength(1)
      expect(Script.fromASM('OP_0').toHex()).toEqual('00')
      expect(Script.fromASM('0').toHex()).toEqual('00')
      expect(Script.fromASM('OP_FALSE').toHex()).toEqual('00')
    })

    it('writes a zero-length push as OP_0', () => {
      const pushdata1 = Script.fromHex('4c00')
      expect(pushdata1.toHex()).toEqual('4c00')
      expect(pushdata1.toASM()).toEqual('OP_0')
      expect(Script.fromASM(pushdata1.toASM()).toASM()).toEqual('OP_0')

      const insideBranch = Script.fromHex('00634c006851')
      expect(insideBranch.toASM()).toEqual('OP_0 OP_IF OP_0 OP_ENDIF OP_1')
      expect(Script.fromASM(insideBranch.toASM()).toASM()).toEqual(insideBranch.toASM())
    })
    it('should parse this known script in ASM', () => {
      const asm =
        'OP_DUP OP_HASH160 f4c03610e60ad15100929cc23da2f3a799af1725 OP_EQUALVERIFY OP_CHECKSIG'
      const script = Script.fromASM(asm)

      expect(script.chunks[0].op).toEqual(OP.OP_DUP)
      expect(script.chunks[1].op).toEqual(OP.OP_HASH160)
      expect(script.chunks[2].op).toEqual(20)

      // Ensure `data` is defined before calling `toHex`
      expect(toHex(script.chunks[2].data ?? [])).toEqual('f4c03610e60ad15100929cc23da2f3a799af1725')

      expect(script.chunks[3].op).toEqual(OP.OP_EQUALVERIFY)
      expect(script.chunks[4].op).toEqual(OP.OP_CHECKSIG)
    })

    it('should parse this known problematic script in ASM', () => {
      const asm = 'OP_RETURN 026d02 0568656c6c6f'
      const script = Script.fromASM(asm)
      expect(script.toASM()).toEqual(asm)
    })

    it('should know this is invalid hex', () => {
      const asm = 'OP_RETURN 026d02 0568656c6c6fzz'

      const createScript = (): string => {
        const script = Script.fromASM(asm)
        return script.toASM()
      }

      // Expect the function to throw an error with the specified message
      expect(createScript).toThrow('Invalid hex string')
    })

    it('should parse this long PUSHDATA1 script in ASM', () => {
      const buf = Buffer.alloc(220, 0)
      const asm = 'OP_RETURN ' + buf.toString('hex')
      const script = Script.fromASM(asm)
      expect(script.chunks[1].op).toEqual(OP.OP_PUSHDATA1)
      expect(script.toASM()).toEqual(asm)
    })

    it('should parse this long PUSHDATA2 script in ASM', () => {
      const buf = Buffer.alloc(1024, 0)
      const asm = 'OP_RETURN ' + buf.toString('hex')
      const script = Script.fromASM(asm)
      expect(script.chunks[1].op).toEqual(OP.OP_PUSHDATA2)
      expect(script.toASM()).toEqual(asm)
    })

    it('should parse this long PUSHDATA4 script in ASM', () => {
      const buf = Buffer.alloc(Math.pow(2, 17), 0)
      const asm = 'OP_RETURN ' + buf.toString('hex')
      const script = Script.fromASM(asm)
      expect(script.chunks[1].op).toEqual(OP.OP_PUSHDATA4)
      expect(script.toASM()).toEqual(asm)
    })

    it('should normalize false aliases to OP_0', () => {
      const asm1 = 'OP_FALSE'
      const asm2 = 'OP_0'
      const asm3 = '0'
      expect(Script.fromASM(asm1).toASM()).toEqual(asm2)
      expect(Script.fromASM(asm2).toASM()).toEqual(asm2)
      expect(Script.fromASM(asm3).toASM()).toEqual(asm2)
    })

    it('should normalize -1 to OP_1NEGATE', () => {
      const asm1 = 'OP_1NEGATE'
      const asm2 = '-1'
      expect(Script.fromASM(asm1).toASM()).toEqual(asm1)
      expect(Script.fromASM(asm2).toASM()).toEqual(asm1)
    })
  })

  describe('#removeCodeseparators', () => {
    it('should remove any OP_CODESEPARATORs', () => {
      expect(
        Script.fromASM('OP_CODESEPARATOR OP_0 OP_CODESEPARATOR').removeCodeseparators().toASM()
      ).toEqual('OP_0')
    })
  })

  describe('#isPushOnly', () => {
    it("should know these scripts are or aren't push only", () => {
      expect(Script.fromASM('OP_0').isPushOnly()).toEqual(true)
      expect(Script.fromASM('OP_0 OP_RETURN').isPushOnly()).toEqual(false)
      expect(Script.fromASM('OP_PUSHDATA1 5 1010101010').isPushOnly()).toEqual(true)

      // like bitcoind, we regard OP_RESERVED as being "push only"
      expect(Script.fromASM('OP_RESERVED').isPushOnly()).toEqual(true)
    })
  })

  describe('#findAndDelete', () => {
    it('should delete all matching single-chunk scripts', () => {
      const target = new Script().writeBin([0xf0, 0xf0])
      const script = new Script()
        .writeOpCode(OP.OP_RETURN)
        .writeBin([0xf0, 0xf0])
        .writeOpCode(OP.OP_1)
        .writeBin([0xf0, 0xf0])

      expect(script.findAndDelete(target).toASM()).toEqual('OP_RETURN OP_1')
    })

    it('should match OP_RETURN chunks with data', () => {
      const target = new Script([{ op: OP.OP_RETURN, data: [0x01, 0x02, 0x03] }])
      const script = new Script([{ op: OP.OP_RETURN, data: [0x01, 0x02, 0x03] }, { op: OP.OP_1 }])

      expect(script.findAndDelete(target).toASM()).toEqual('OP_1')
    })

    it('should handle PUSHDATA2 payloads', () => {
      const data = Array.from({ length: 300 }, (_, i) => i & 0xff)
      const other = data.slice()
      other[0] = (other[0] + 1) & 0xff

      const target = new Script().writeBin(data)
      const script = new Script().writeBin(other).writeBin(data).writeOpCode(OP.OP_1)

      script.findAndDelete(target)
      expect(script.chunks).toHaveLength(2)
      expect(script.chunks[0].data).toEqual(other)
      expect(script.chunks[1].op).toEqual(OP.OP_1)
    })

    it('should not delete when the target has multiple chunks', () => {
      const script = Script.fromASM('OP_1')
      const target = Script.fromASM('OP_1 OP_2')
      expect(script.findAndDelete(target).toASM()).toEqual('OP_1')
    })
  })

  describe('vectors', () => {
    scriptValid.forEach((a, i) => {
      if (a.length === 1) {
        return
      }
      it(`should not fail when reading scriptValid vector ${i}`, () => {
        expect(() => {
          Script.fromHex(a[0]).toHex()
          Script.fromHex(a[0]).toASM()
        }).not.toThrow()

        expect(() => {
          Script.fromHex(a[1]).toHex()
          Script.fromHex(a[1]).toASM()
        }).not.toThrow()

        // should be able to return the same output over and over
        let str = Script.fromHex(a[0]).toASM()
        expect(Script.fromASM(str).toASM()).toEqual(str)
        str = Script.fromHex(a[1]).toASM()
        expect(Script.fromASM(str).toASM()).toEqual(str)
      })
    })

    scriptInvalid.forEach((a, i) => {
      if (a.length === 1) {
        return
      }

      it(`should not fail when reading scriptInvalid vector ${i}`, () => {
        // Test that no errors are thrown for the first item
        expect(() => {
          const scriptA = Script.fromHex(a[0])
          scriptA.toHex()
          scriptA.toASM()
        }).not.toThrow()

        // Test that no errors are thrown for the second item
        expect(() => {
          const scriptB = Script.fromHex(a[1])
          scriptB.toHex()
          scriptB.toASM()
        }).not.toThrow()

        // Test that it should be able to return the same output over and over for the first item
        const strA = Script.fromHex(a[0]).toASM()
        expect(Script.fromASM(strA).toASM()).toEqual(strA)

        // Test that it should be able to return the same output over and over for the second item
        const strB = Script.fromHex(a[1]).toASM()
        expect(Script.fromASM(strB).toASM()).toEqual(strB)
      })
    })
  })

  describe('Empty binarys should equal OP_0', () => {
    it('should correctly write empty binary arrays', () => {
      const script = new Script().writeBin([])
      expect(script.toASM()).toEqual('OP_0')
    })
  })
})
