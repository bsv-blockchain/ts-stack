import { LockingScript } from '@bsv/sdk';
import { WalletDerivationParams } from '../../types/wallet';
import { Inscription, MAP } from '../../script-templates/ordinal';
import { OrdLockLockParams } from '../../script-templates/types';
/**
 * Configuration for a transaction output
 */
export type OutputConfig = {
    type: 'p2pkh';
    satoshis: number;
    description?: string;
    addressOrParams?: string | WalletDerivationParams;
    opReturnFields?: Array<string | number[]>;
    basket?: string;
    customInstructions?: string;
} | {
    type: 'ordinalP2PKH';
    satoshis: number;
    description?: string;
    addressOrParams?: string | WalletDerivationParams;
    inscription?: Inscription;
    metadata?: MAP;
    opReturnFields?: Array<string | number[]>;
    basket?: string;
    customInstructions?: string;
} | {
    type: 'ordLock';
    satoshis: number;
    description?: string;
    ordLockParams: OrdLockLockParams;
    opReturnFields?: Array<string | number[]>;
    basket?: string;
    customInstructions?: string;
} | {
    type: 'custom';
    satoshis: number;
    description?: string;
    lockingScript: LockingScript;
    opReturnFields?: Array<string | number[]>;
    basket?: string;
    customInstructions?: string;
} | {
    type: 'change';
    satoshis?: number;
    description?: string;
    addressOrParams?: string | WalletDerivationParams;
    opReturnFields?: Array<string | number[]>;
    basket?: string;
    customInstructions?: string;
};
//# sourceMappingURL=output-config.d.ts.map