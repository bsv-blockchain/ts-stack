import LockingScript from '../LockingScript'
import ScriptEvaluationError from '../ScriptEvaluationError'
import ScriptResourceLimitError from '../ScriptResourceLimitError'
import Spend from '../Spend'
import Transaction from '../../transaction/Transaction'
import TransactionSignature from '../../primitives/TransactionSignature'
import Script from '../Script'

// Minimal synthetic transactions for node v1.2.2 conformance. These assert
// node v1.2.2 block/relay verdicts, not error-message wording.
const vectors = [
  {
    name: '1: crypto-00012',
    classNumber: 1,
    lockHex: '21035935f55855afd8c999bdb5a8d08ae8e73b7618e200d4ef7687cd55d3c2e4c9d7ac91',
    coinHeight: 967896,
    txHex:
      '0200000001d9fa799b3044ad9589c87a3e67980b12da738e9b13542dd868726cf0a0b39e250000000049483045022100d7d09ade8b4adb6372ef31dab5fe96ef44e0661156c1ecf6f81a8353d14060650220057e129a333dda81260ba7ee86b8a15cf88e51ef06a5d30cdebbbfc4f10d361341ffffffff010100000000000000015100000000',
    valid: true
  },
  {
    name: '1: flow-00961',
    classNumber: 1,
    lockHex: '51',
    coinHeight: 967896,
    txHex:
      '02000000010a7b1c40c67f02436acff2a4b6e22ca7b3deb60852f4c10f18e05f07e5d0f5260000000002516affffffff010100000000000000015100000000',
    valid: true
  },
  {
    name: '1: arith-00351',
    classNumber: 1,
    lockHex: '020100985287',
    coinHeight: 967896,
    txHex:
      '020000000120aaf54d327d617af4e5bb4a3db9d7d135afe0ff8f03bd59cc79eb969fb988e600000000014fffffffff010100000000000000015100000000',
    valid: true
  },
  {
    name: '2: eras-00001',
    classNumber: 2,
    lockHex: '516a',
    coinHeight: 620537,
    txHex:
      '02000000018e7c542db81ed89b3270ff26342988db87785631329107fb7a0e11ded53b6e6d0000000000ffffffff010100000000000000015100000000',
    valid: false
  },
  {
    name: '2: eras-00019',
    classNumber: 2,
    lockHex: '5163516700675168',
    coinHeight: 620537,
    txHex:
      '0200000001f01a60cf6e52c646d620388d2619756c63fafc35e451377d37bb2e638ed8f4c10000000000ffffffff010100000000000000015100000000',
    valid: true
  },
  {
    name: '3: gen-00006',
    classNumber: 3,
    lockHex: '5103b1710b808b7551',
    coinHeight: 620538,
    txHex:
      '0200000001d778b0553b5c7c553a74ae08b43a94b3fc9fc3097fde32fb54d29970050fb8ed0000000000ffffffff010100000000000000015100000000',
    valid: false
  },
  {
    name: '3: gen-00009',
    classNumber: 3,
    lockHex: '51040148e801808b7551',
    coinHeight: 943816,
    txHex:
      '02000000010282f68044beaa91d8f3424e5499046c9a2fc62222344f786bdf10882a0dcb050000000000ffffffff010100000000000000015100000000',
    valid: false
  },
  {
    name: '4: gen-00974',
    classNumber: 4,
    lockHex: '2103913a7b50432835163ebc6aa9cad8c3f52e6a37df35be520213a2fa5c0be9b353ac',
    coinHeight: 620538,
    txHex:
      '0200000001421e09a1497b8976eafb681be43ab7ff15ca2075266f785f9610e4f935a8f8360000000049483045022100874e74f0c4921c200fbb90fd537ebefb84844f1b74d02355896bee35d213ee1b022048a1a59726aa089318f650f58b413615f32789d9eba562f6a1254d657f75992d61ffffffff02010000000000000001510200000000000000015100000000',
    valid: true
  },
  {
    name: '5: crypto-00084 (version 1)',
    classNumber: 5,
    lockHex:
      '473044022072b7e219170a2ae089c149ae684a1a7ad50a3251ad466b94a145b86bb76d150002205190440eb08efa92ced4e80a9c2f8e2721cf21a9c14d81015d16c05686eda235417521035935f55855afd8c999bdb5a8d08ae8e73b7618e200d4ef7687cd55d3c2e4c9d7ac',
    coinHeight: 967896,
    txHex:
      '01000000010339699bf39cbdfa8e8965583d70faa0301fe96efc6f17053cbbb31ff1d0b7670000000048473044022072b7e219170a2ae089c149ae684a1a7ad50a3251ad466b94a145b86bb76d150002205190440eb08efa92ced4e80a9c2f8e2721cf21a9c14d81015d16c05686eda23541ffffffff010100000000000000015100000000',
    valid: false
  },
  {
    name: '6: gen-01001',
    classNumber: 6,
    lockHex: '2103913a7b50432835163ebc6aa9cad8c3f52e6a37df35be520213a2fa5c0be9b353ac6a4d05',
    coinHeight: 943816,
    txHex:
      '0200000001df9aea25028895f34dd187cd56c319ed0eb8d6896c2cd0866bc0544fe52394d9000000004847304402204519a364c695b04b7e5017be05deb0a3fdf25d09d31f0940b3e9efedbe7f496f02202c7b917f465dd4a505816f2a28d839d2044dbbdaeb1df9f3c39e9975c6f7e3de61ffffffff010100000000000000015100000000',
    valid: true
  },
  {
    name: '6: gen-00999',
    classNumber: 6,
    lockHex: '2103913a7b50432835163ebc6aa9cad8c3f52e6a37df35be520213a2fa5c0be9b353ac6a4c05aabb',
    coinHeight: 943816,
    txHex:
      '0200000001f81e0cf3c931477cbe57a9388d22c15466688974e66c7a7fae77a5623925265d0000000049483045022100e7bd08a7cf0a1bda318923e1e931e83070adb546eed21d79fbc92ef12966f958022071a9fada8e08eafc1758a8dc47501e4999ea89774872a3d96d0611d5aab7548761ffffffff010100000000000000015100000000',
    valid: true
  },
  {
    name: '7: eras-00015',
    classNumber: 7,
    lockHex: '51b17551',
    coinHeight: 620537,
    txHex:
      '0200000001b4b3e19df37673ec4804630b153244aa2a83317c5ba79e4b78c085849df944050000000000feffffff010100000000000000015100000000',
    valid: false
  },
  {
    name: '7: eras-00052',
    classNumber: 7,
    lockHex: '51b17551',
    coinHeight: 100,
    txHex:
      '0200000001bed48f683afbb0e47b069b3120ccc36eff75c5e5183bc47362c878543816d2160000000000feffffff010100000000000000015100000000',
    valid: false
  },
  {
    name: '8: eras-00017',
    classNumber: 8,
    lockHex: '51b27551',
    coinHeight: 620537,
    txHex:
      '020000000149186975113ea88ff53e1c51d65bc3338afe5d704801d927a4fe8db8224e6b6a000000000000000000010100000000000000015100000000',
    valid: false
  },
  {
    name: '8: eras-00054',
    classNumber: 8,
    lockHex: '51b27551',
    coinHeight: 100,
    txHex:
      '0200000001c1bf107a0b3b61e2511f9914dfdb0eb4399042a51493aa7d7c0fe9ee82709471000000000000000000010100000000000000015100000000',
    valid: false
  },
  {
    name: '9: bytes-00435 (version 1)',
    classNumber: 9,
    lockHex: 'b2',
    coinHeight: 967896,
    txHex:
      '01000000017e41122de6de8c7c28680fc3a234f7838c43e6592331fe4a0ad68ae13462f6250000000006515253545556ffffffff010100000000000000015100000000',
    valid: true
  },
  {
    name: '11: gen-00795',
    classNumber: 11,
    lockHex: '10000102030405060708090a0b0c0d0e0f0904000000000000008054b3040405060787',
    coinHeight: 943816,
    txHex:
      '0200000001bd713e289714213b3d76b5168a550fe3bc8bee30363eb9a72795e051c88686500000000000ffffffff010100000000000000015100000000',
    valid: true
  },
  {
    name: '12: gen-00835',
    classNumber: 12,
    lockHex: '51050000008000b77551',
    coinHeight: 943816,
    txHex:
      '0200000001829896aed1733429283adb214280217591f00929568490f2c8530c8a9f7260310000000000ffffffff010100000000000000015100000000',
    valid: false
  },
  {
    name: '13: arith-00163',
    classNumber: 13,
    lockHex: '04ffffff7f98010087',
    coinHeight: 967896,
    txHex:
      '0200000001bbc9d9c85aca832a951c9630dbb352b3c012b48c1ecbcfb12ff5bcc67f9fc833000000000153ffffffff010100000000000000015100000000',
    valid: true
  },
  {
    name: '13: gen-00813',
    classNumber: 13,
    lockHex: '5104ffffff7fb67551',
    coinHeight: 943816,
    txHex:
      '0200000001503dd6f80c4ebe381c7c8fb609d1555c2ea5fa2aa59f002acd05151f46c7ad5d0000000000ffffffff010100000000000000015100000000',
    valid: false
  },
  {
    name: '14: stack-00217',
    classNumber: 14,
    lockHex: '0500000080008051',
    coinHeight: 967896,
    txHex:
      '020000000187a34732a06ac0f3edeca5c9a239399da4c91d80f507fbd34c06ce985d415f27000000000151ffffffff010100000000000000015100000000',
    valid: false
  }
] as const

const currentBlockFlags = [
  'P2SH',
  'STRICTENC',
  'DERSIG',
  'LOW_S',
  'SIGPUSHONLY',
  'CHECKLOCKTIMEVERIFY',
  'CHECKSEQUENCEVERIFY',
  'NULLFAIL',
  'SIGHASH_FORKID',
  'GENESIS',
  'CHRONICLE'
]

function createSpend(
  txHex: string,
  lockHex: string,
  coinHeight: number,
  index: number = 0,
  label: string = ''
): Spend {
  const tx = Transaction.fromHex(txHex)
  const input = tx.inputs[index]
  let verifyFlags = [...currentBlockFlags]
  if (label === 'eras-00052') {
    verifyFlags = ['P2SH', 'DERSIG', 'CHECKLOCKTIMEVERIFY']
  } else if (label === 'eras-00054') {
    verifyFlags = ['P2SH', 'DERSIG', 'CHECKLOCKTIMEVERIFY', 'CHECKSEQUENCEVERIFY']
  } else {
    if (coinHeight >= 620538) verifyFlags.push('UTXO_AFTER_GENESIS')
    if (coinHeight >= 943816) verifyFlags.push('UTXO_AFTER_CHRONICLE')
  }
  if (label === 'arith-00351') {
    verifyFlags.push('NULLDUMMY', 'MINIMALDATA', 'DISCOURAGE_UPGRADABLE_NOPS', 'CLEANSTACK')
  }
  return new Spend({
    sourceTXID: input.sourceTXID!,
    sourceOutputIndex: input.sourceOutputIndex,
    sourceSatoshis: 1000,
    lockingScript: LockingScript.fromHex(lockHex),
    transactionVersion: tx.version,
    otherInputs: tx.inputs.filter((_, inputIndex) => inputIndex !== index),
    allInputs: tx.inputs,
    outputs: tx.outputs,
    unlockingScript: input.unlockingScript!,
    inputSequence: input.sequence ?? 0xffffffff,
    inputIndex: index,
    lockTime: tx.lockTime,
    memoryLimit: label === 'stack-00217' ? 1024 : label === 'gen-00009' ? 33_000_000 : undefined,
    verifyFlags
  })
}

describe('node script conformance regressions', () => {
  it.each(vectors)('$name', ({ name, lockHex, coinHeight, txHex, valid }) => {
    const label = name.slice(name.indexOf(': ') + 2)
    const spend = createSpend(txHex, lockHex, coinHeight, 0, label)
    if (valid) {
      expect(spend.validateJavaScript()).toBe(true)
    } else {
      expect(() => spend.validateJavaScript()).toThrow(ScriptEvaluationError)
    }
  })

  it('retains the version-one push-only rule after Chronicle', () => {
    const vector = vectors.find(item => item.name === '1: flow-00961')!
    const versionOneTx = `01${vector.txHex.slice(2)}`
    const spend = createSpend(versionOneTx, vector.lockHex, vector.coinHeight)
    expect(() => spend.validateJavaScript()).toThrow(ScriptEvaluationError)
  })

  it('accepts a satisfied pre-Genesis absolute lock time', () => {
    const vector = vectors.find(item => item.name === '7: eras-00015')!
    const spend = createSpend(vector.txHex, vector.lockHex, vector.coinHeight)
    spend.lockTime = 1
    expect(spend.validateJavaScript()).toBe(true)
  })

  it('checks the pre-Genesis relative lock against the input sequence and type', () => {
    const vector = vectors.find(item => item.name === '8: eras-00017')!
    const spend = createSpend(vector.txHex, vector.lockHex, vector.coinHeight)
    spend.inputSequence = 1
    expect(spend.validateJavaScript()).toBe(true)
    spend.inputSequence = 0x00400001
    expect(() => spend.validateJavaScript()).toThrow(ScriptEvaluationError)
  })

  it('returns a zero-width-preserving result for a huge right byte shift', () => {
    const vector = vectors.find(item => item.name === '13: arith-00163')!
    const lockHex = vector.lockHex.replace('98010087', '99010087')
    expect(createSpend(vector.txHex, lockHex, vector.coinHeight).validateJavaScript()).toBe(true)
  })

  it('rejects a numeric left shift count above the node int32 bound', () => {
    const vector = vectors.find(item => item.name === '12: gen-00835')!
    const lockHex = vector.lockHex.replace('b7', 'b6')
    expect(() =>
      createSpend(vector.txHex, lockHex, vector.coinHeight).validateJavaScript()
    ).toThrow(ScriptEvaluationError)
  })

  it.each([
    ['complete PUSHDATA2', '4d0100aa', '044d0100aa'],
    ['complete PUSHDATA4', '4e01000000aa', '064e01000000aa'],
    ['truncated PUSHDATA4 length', '6a4e050000', '056a4e'],
    ['truncated PUSHDATA4 body', '6a4e05000000aabb', '086a4e05000000']
  ])('serializes the original digest script walk for %s', (_name, scriptHex, expectedHex) => {
    const preimage = TransactionSignature.formatOTDA({
      sourceTXID: '00'.repeat(32),
      sourceOutputIndex: 0,
      sourceSatoshis: 1000,
      transactionVersion: 2,
      otherInputs: [],
      outputs: [],
      inputIndex: 0,
      subscript: Script.fromHex(scriptHex),
      inputSequence: 0xffffffff,
      lockTime: 0,
      scope: TransactionSignature.SIGHASH_NONE | TransactionSignature.SIGHASH_ANYONECANPAY
    })
    // Version, input count, outpoint precede this CompactSize and script body.
    expect(Buffer.from(preimage.slice(41, -13)).toString('hex')).toBe(expectedHex)
  })

  it('reports local resource exhaustion for the largest node-representable NUM2BIN size', () => {
    const vector = vectors.find(item => item.name === '14: stack-00217')!
    const spend = createSpend(vector.txHex, '04ffffff7f8051', vector.coinHeight, 0, 'stack-00217')
    expect(() => spend.validateJavaScript()).toThrow(ScriptResourceLimitError)
  })

  it('uses the original digest for a pre-UAHF FORKID-bit signature', () => {
    const txHex =
      '02000000031c03d65739de2b55f51b600abb4b3eba4c3bbc3c62244bf10eaa53b6c63d39ad000000004948304502210080089464b438a3c3b800805194aaf845845ff0fb73dd55da5bc32a2ba016a0da022003e74a9cf63659240c2814006ada6fb982fdf01c292bff03da79692cafb6c5cd01ffffffff140155ec0e942dc40a8f418e720b4e996e50788fb0b5a4e23a5659df6f939063000000004847304402207acc9a382964cf2c03c83df3f877ddaa942ecfd5fb48c9e4636b1ee46fea0a29022022373d2f768a83c2b5f0a843c0e48bd19716922c4831ba083a4a0e25f14005a641ffffffff8e47aab4115643d43d0428135ef7eb3d37472c0cfec5e3eda8339921f8efeb4a000000004847304402206e1f94c990cb392dab5e7e46faa775bdfeea9ab8787cba307de9c3f7bcec046b022015bedb0d8f5e295de76de219de674c41649057f8e77494855c868b709e14667901ffffffff02010000000000000001510200000000000000015100000000'
    const locks = [
      '2103913a7b50432835163ebc6aa9cad8c3f52e6a37df35be520213a2fa5c0be9b353ac',
      '2103c10f4fba86c5439080cb87226bc19b344eb56e6f4f6db673b6674fdfa63f6d57ac',
      '2102dae175dcbf94e5b79a4a53a67ba1259b7825079ec03b2c39101b9438eff5d904ac'
    ]
    for (let index = 0; index < locks.length; index++) {
      const spend = createSpend(txHex, locks[index], 478000, index)
      spend.verifyFlags = new Set(['P2SH', 'DERSIG', 'CHECKLOCKTIMEVERIFY', 'CHECKSEQUENCEVERIFY'])
      expect(spend.validateJavaScript()).toBe(true)
    }
  })
})
