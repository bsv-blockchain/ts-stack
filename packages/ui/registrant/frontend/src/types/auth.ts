import { WalletInterface } from "@bsv/sdk";

export type AuthMethod = 'wallet' | 'privateKey';

export interface AuthState {
  isAuthenticated: boolean;
  method?: AuthMethod;
  wallet?: WalletInterface
}
