import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

function sourceLineRange(repositoryRoot, packageDirectory, filePath, startMarker, endMarker) {
  const lines = readFileSync(resolve(repositoryRoot, packageDirectory, filePath), 'utf8').split(
    '\n'
  )
  const startIndex = lines.findIndex(line => line.includes(startMarker))
  const endIndex = lines.findIndex((line, index) => index > startIndex && line.includes(endMarker))

  if (startIndex === -1 || endIndex === -1) {
    throw new Error(
      `Unable to resolve mutation range in ${filePath}: ${startMarker} .. ${endMarker}`
    )
  }

  return `${filePath}:${startIndex + 1}-${endIndex}`
}

function jestTarget(configFile, testMatch, { esm = false, config = {}, findRelated = false } = {}) {
  return {
    testRunner: 'jest',
    runnerOptions: {
      jest: {
        projectType: 'custom',
        configFile,
        enableFindRelatedTests: findRelated,
        ...(testMatch === undefined
          ? {}
          : {
              config: {
                ...config,
                testMatch
              }
            })
      },
      ...(esm ? { testRunnerNodeArgs: ['--experimental-vm-modules'] } : {})
    }
  }
}

function vitestTarget(configFile) {
  return {
    testRunner: 'vitest',
    runnerOptions: {
      vitest: {
        configFile,
        related: true
      }
    }
  }
}

export function buildMutationTargets(repositoryRoot) {
  return {
    'sdk-codecs': {
      packageDirectory: 'packages/sdk',
      manifest: 'packages/sdk/package.json',
      propertyTest: 'packages/sdk/src/primitives/__tests/utils.property.test.ts',
      mutate: [
        sourceLineRange(
          repositoryRoot,
          'packages/sdk',
          'src/primitives/utils.ts',
          'const lz = str.match(',
          'type WriterChunk'
        )
      ],
      ...jestTarget('jest.config.js', ['<rootDir>/src/primitives/__tests/utils.property.test.ts'], {
        esm: true
      })
    },
    'wallet-action-batch': {
      packageDirectory: 'packages/wallet/wallet-toolbox',
      manifest: 'packages/wallet/wallet-toolbox/package.json',
      propertyTest:
        'packages/wallet/wallet-toolbox/src/utility/__tests/actionBatchPack.property.test.ts',
      mutate: ['src/utility/actionBatchPack.ts:38-132'],
      ...jestTarget(
        'jest.config.cjs',
        [
          '<rootDir>/src/utility/__tests/actionBatchPack*.test.ts',
          '<rootDir>/src/utility/__tests__/actionBatchPack*.test.ts'
        ],
        {
          config: {
            moduleNameMapper: {
              '^@bsv/sdk$': resolve(repositoryRoot, 'packages/sdk/mod.ts'),
              '^(\\.{1,2}/.*)\\.js$': '$1'
            }
          }
        }
      )
    },
    'overlay-linkage': {
      packageDirectory: 'packages/overlays/topics',
      manifest: 'packages/overlays/topics/package.json',
      propertyTest: 'packages/overlays/topics/src/mandala/__tests/types.property.test.ts',
      mutate: ['src/mandala/types.ts:72-78', 'src/admission/issuerPolicy.ts:36-39'],
      ...jestTarget('jest.config.js', ['<rootDir>/src/mandala/__tests/types*.test.ts'], {
        esm: true
      })
    },
    'did-codecs': {
      packageDirectory: 'packages/helpers/did',
      manifest: 'packages/helpers/did/package.json',
      propertyTest: 'packages/helpers/did/tests/codec.property.test.ts',
      mutate: ['src/utils/base64url.ts', 'src/utils/multibase.ts'],
      ...jestTarget(
        'jest.config.js',
        ['<rootDir>/tests/codec.property.test.ts', '<rootDir>/tests/did.test.ts'],
        { esm: true }
      )
    },
    'mandala-encoding': {
      packageDirectory: 'packages/helpers/ts-templates',
      manifest: 'packages/helpers/ts-templates/package.json',
      propertyTest: 'packages/helpers/ts-templates/src/__tests/mandala-encoding.property.test.ts',
      mutate: ['src/mandala-encoding.ts'],
      ...jestTarget('jest.config.js', ['<rootDir>/src/__tests/mandala-encoding*.test.ts'])
    },
    'paymail-address': {
      packageDirectory: 'packages/messaging/ts-paymail',
      manifest: 'packages/messaging/ts-paymail/package.json',
      propertyTest: 'packages/messaging/ts-paymail/src/__tests/paymailAddress.property.test.ts',
      mutate: ['src/paymailAddress.ts'],
      ...jestTarget('jest.config.js', ['<rootDir>/src/__tests/paymailAddress*.test.ts'], {
        esm: true
      })
    },
    'p2p-messages': {
      packageDirectory: 'packages/network/ts-p2p',
      manifest: 'packages/network/ts-p2p/package.json',
      propertyTest: 'packages/network/ts-p2p/test/messages.property.test.ts',
      mutate: ['src/messages.ts:139-231'],
      ...jestTarget('jest.config.js', ['<rootDir>/test/messages*.test.ts'], { esm: true })
    },
    auth: {
      packageDirectory: 'packages/middleware/auth',
      manifest: 'packages/middleware/auth/package.json',
      propertyTest: 'packages/middleware/auth/src/__tests__/core.property.test.ts',
      mutate: ['src/core.ts'],
      ...jestTarget('jest.config.js', [
        '<rootDir>/src/__tests__/authProof.test.ts',
        '<rootDir>/src/__tests__/core.property.test.ts'
      ])
    },
    'reorg-stream': {
      packageDirectory: 'packages/overlays/overlay-express',
      manifest: 'packages/overlays/overlay-express/package.json',
      propertyTest: 'packages/overlays/overlay-express/src/__tests/ReorgStream.property.test.ts',
      mutate: ['src/ReorgStream.ts'],
      ...jestTarget(
        'jest.config.js',
        [
          '<rootDir>/src/__tests/ReorgStream*.test.ts',
          '<rootDir>/src/__tests__/ReorgStream*.test.ts'
        ],
        {
          esm: true
        }
      )
    },
    'message-box-host': {
      packageDirectory: 'packages/messaging/message-box-client',
      manifest: 'packages/messaging/message-box-client/package.json',
      propertyTest: 'packages/messaging/message-box-client/src/__tests/host.property.test.ts',
      mutate: ['src/host.ts'],
      ...jestTarget('jest.config.ts', ['<rootDir>/src/__tests/host*.test.ts'], { esm: true })
    },
    'wallet-pairing': {
      packageDirectory: 'packages/wallet/ts-wallet-relay',
      manifest: 'packages/wallet/ts-wallet-relay/package.json',
      propertyTest: 'packages/wallet/ts-wallet-relay/tests/pairingUri.property.test.ts',
      mutate: ['src/shared/pairingUri.ts'],
      ...jestTarget('jest.mutation.config.cjs', undefined)
    },
    'overlay-advertisement': {
      packageDirectory: 'packages/overlays/overlay-discovery-services',
      manifest: 'packages/overlays/overlay-discovery-services/package.json',
      propertyTest:
        'packages/overlays/overlay-discovery-services/src/utils/__tests/isAdvertisableURI.property.test.ts',
      mutate: ['src/utils/isAdvertisableURI.ts', 'src/utils/isValidTopicOrServiceName.ts'],
      ...jestTarget(
        'jest.config.js',
        [
          '<rootDir>/src/utils/__tests/isAdvertisableURI*.test.ts',
          '<rootDir>/src/utils/__tests/isValidTopicOrServiceName*.test.ts'
        ],
        { esm: true }
      )
    },
    'overlay-integrity': {
      packageDirectory: 'packages/overlays/overlay',
      manifest: 'packages/overlays/overlay/package.json',
      propertyTest: 'packages/overlays/overlay/src/__tests/BASM.property.test.ts',
      mutate: ['src/BASM.ts:154-190', 'src/SafeLog.ts'],
      ...jestTarget('jest.config.js', [
        '<rootDir>/src/__tests/BASM.test.ts',
        '<rootDir>/src/__tests/BASM.property.test.ts',
        '<rootDir>/src/__tests/SafeLog.test.ts'
      ])
    },
    'verifast-batch': {
      packageDirectory: 'packages/verifast',
      manifest: 'packages/verifast/package.json',
      propertyTest: 'packages/verifast/src/__tests/BdkBatch.property.test.ts',
      mutate: ['src/BdkBatch.ts'],
      ...jestTarget('jest.config.js', ['<rootDir>/src/__tests/BdkBatch*.test.ts'], {
        esm: true,
        config: {
          moduleNameMapper: {
            '^@bsv/sdk$': resolve(repositoryRoot, 'packages/sdk/mod.ts'),
            '^(\\.{1,2}/.*)\\.js$': '$1'
          }
        }
      })
    },
    'btms-helpers': {
      packageDirectory: 'packages/wallet/btms',
      manifest: 'packages/wallet/btms/package.json',
      propertyTest: 'packages/wallet/btms/src/__tests/BTMSHelpers.property.test.ts',
      mutate: [
        'src/BTMSHelpers.ts:24-27',
        'src/BTMSHelpers.ts:195-203',
        'src/BTMSHelpers.ts:238-256',
        'src/utils.ts:28-67'
      ],
      ...jestTarget(
        'jest.config.cjs',
        ['<rootDir>/src/__tests/BTMSHelpers*.test.ts', '<rootDir>/src/__tests/utils*.test.ts'],
        { esm: true }
      )
    },
    'amount-format': {
      packageDirectory: 'packages/helpers/amountinator',
      manifest: 'packages/helpers/amountinator/package.json',
      propertyTest: 'packages/helpers/amountinator/tests/amountFormat.property.test.ts',
      mutate: ['src/utils/amountFormatHelpers.ts', 'src/utils/currencyConverter.ts:208-260'],
      ...jestTarget('jest.config.cjs', [
        '<rootDir>/tests/amountFormat.property.test.ts',
        '<rootDir>/tests/formatAmountWithCurrency.test.ts'
      ])
    },
    'fund-wallet-cli': {
      packageDirectory: 'packages/helpers/fund-wallet',
      manifest: 'packages/helpers/fund-wallet/package.json',
      propertyTest: 'packages/helpers/fund-wallet/src/cli.property.test.ts',
      mutate: ['src/cli.ts:188-256'],
      ...vitestTarget('vitest.config.ts')
    },
    'payment-402': {
      packageDirectory: 'packages/middleware/402-pay',
      manifest: 'packages/middleware/402-pay/package.json',
      propertyTest: 'packages/middleware/402-pay/src/server.property.test.ts',
      mutate: ['src/server.ts'],
      ...vitestTarget('vitest.config.ts')
    },
    'auth-express-bytes': {
      packageDirectory: 'packages/middleware/auth-express-middleware',
      manifest: 'packages/middleware/auth-express-middleware/package.json',
      propertyTest:
        'packages/middleware/auth-express-middleware/src/__tests/authMiddlewareHelpers.property.test.ts',
      mutate: ['src/authMiddlewareHelpers.ts:96-103', 'src/authMiddlewareHelpers.ts:186-213'],
      ...jestTarget('jest.config.js', ['<rootDir>/src/__tests/authMiddlewareHelpers*.test.ts'])
    },
    'payment-replay': {
      packageDirectory: 'packages/middleware/payment-express-middleware',
      manifest: 'packages/middleware/payment-express-middleware/package.json',
      propertyTest:
        'packages/middleware/payment-express-middleware/src/__tests/PaymentReplayStore.property.test.ts',
      mutate: ['src/index.ts:27-44'],
      ...jestTarget('jest.config.js', ['<rootDir>/src/__tests/PaymentReplayStore*.test.ts'])
    },
    'wallet-script-encoding': {
      packageDirectory: 'packages/helpers/bsv-wallet-helper',
      manifest: 'packages/helpers/bsv-wallet-helper/package.json',
      propertyTest:
        'packages/helpers/bsv-wallet-helper/src/utils/__tests__/scriptEncoding.property.test.ts',
      mutate: [
        'src/utils/opreturn.ts:51-111',
        'src/utils/scriptValidation.ts:102-145',
        'src/utils/scriptValidation.ts:705-749'
      ],
      ...jestTarget('jest.config.js', [
        '<rootDir>/src/utils/__tests__/scriptEncoding*.test.ts',
        '<rootDir>/src/utils/__tests__/opreturn*.test.ts',
        '<rootDir>/src/utils/__tests__/scriptValidation*.test.ts'
      ])
    },
    'create-app-config': {
      packageDirectory: 'packages/helpers/create-bsv-app',
      manifest: 'packages/helpers/create-bsv-app/package.json',
      propertyTest:
        'packages/helpers/create-bsv-app/src/config/__tests__/validate.property.test.ts',
      mutate: ['src/config/validate.ts'],
      ...jestTarget('jest.config.cjs', ['<rootDir>/src/config/__tests__/validate*.test.ts'])
    },
    'gasp-inputs': {
      packageDirectory: 'packages/overlays/gasp-core',
      manifest: 'packages/overlays/gasp-core/package.json',
      propertyTest: 'packages/overlays/gasp-core/src/__tests/GASP.property.test.ts',
      mutate: [
        sourceLineRange(
          repositoryRoot,
          'packages/overlays/gasp-core',
          'src/GASP.ts',
          'private validateTimestamp(',
          'private compute36ByteStructure('
        ),
        sourceLineRange(
          repositoryRoot,
          'packages/overlays/gasp-core',
          'src/GASP.ts',
          'async buildInitialRequest(',
          'async requestNode('
        )
      ],
      ...jestTarget('jest.config.js', ['<rootDir>/src/__tests/GASP*.test.ts'])
    },
    'btms-topic': {
      packageDirectory: 'packages/overlays/btms-backend',
      manifest: 'packages/overlays/btms-backend/package.json',
      propertyTest:
        'packages/overlays/btms-backend/src/topic-managers/__tests/BTMSTopicManager.property.test.ts',
      mutate: ['src/topic-managers/BTMSTopicManager.ts:70-88'],
      ...jestTarget(
        'jest.config.js',
        ['<rootDir>/src/topic-managers/__tests/BTMSTopicManager*.test.ts'],
        { esm: true }
      )
    },
    'btms-permission': {
      packageDirectory: 'packages/wallet/btms-permission-module',
      manifest: 'packages/wallet/btms-permission-module/package.json',
      propertyTest:
        'packages/wallet/btms-permission-module/src/__tests__/BasicTokenModule.property.test.ts',
      mutate: [
        'src/BasicTokenModule.ts:141-172',
        'src/BasicTokenModule.ts:778-818',
        'src/BasicTokenModule.ts:1082-1138'
      ],
      ...jestTarget('jest.config.cjs', ['<rootDir>/src/__tests__/BasicTokenModule*.test.ts'], {
        esm: true
      })
    }
  }
}
