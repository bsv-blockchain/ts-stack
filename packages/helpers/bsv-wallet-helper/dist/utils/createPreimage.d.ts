import { Transaction, Script } from '@bsv/sdk';
export declare function calculatePreimage(tx: Transaction, inputIndex: number, signOutputs: 'all' | 'none' | 'single', anyoneCanPay: boolean, sourceSatoshis?: number, lockingScript?: Script): {
    preimage: number[];
    signatureScope: number;
};
//# sourceMappingURL=createPreimage.d.ts.map