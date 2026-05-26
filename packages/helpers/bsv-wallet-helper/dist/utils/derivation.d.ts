import { WalletInterface, WalletProtocol } from '@bsv/sdk';
export interface Derivation {
    protocolID: WalletProtocol;
    keyID: string;
}
export declare function getDerivation(): Derivation;
export interface AddressWithParams {
    address: string;
    walletParams: {
        protocolID: WalletProtocol;
        keyID: string;
        counterparty: string;
    };
}
export declare function getAddress(wallet: WalletInterface, amount?: number, counterparty?: string): Promise<AddressWithParams[]>;
//# sourceMappingURL=derivation.d.ts.map