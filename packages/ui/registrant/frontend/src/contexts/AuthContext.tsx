
import { createContext, useContext, ReactNode, useState, useEffect } from "react";
import { AuthState, AuthMethod } from "@/types/auth";
import { WalletInterface } from "@bsv/sdk";
import makeWallet from "@/lib/makeWallet";

interface AuthContextType {
  auth: AuthState;
  login: (method: AuthMethod, wallet?: WalletInterface, privateKey?: string) => void;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const SESSION_KEY = 'registrant_auth';
const PRIVATE_KEY_SESSION_KEY = 'registrant_private_key';

export function AuthProvider({ children }: { children: ReactNode }) {
  const [auth, setAuth] = useState<AuthState>({ isAuthenticated: false });
  const [isInitializing, setIsInitializing] = useState(true);

  // Restore session on mount
  useEffect(() => {
    const restoreSession = async () => {
      try {
        const storedAuth = sessionStorage.getItem(SESSION_KEY);
        const storedPrivateKey = sessionStorage.getItem(PRIVATE_KEY_SESSION_KEY);

        if (storedAuth) {
          const authData = JSON.parse(storedAuth);

          // If it was a private key login, recreate the wallet
          if (authData.method === 'privateKey' && storedPrivateKey) {
            const wallet = await makeWallet('main', storedPrivateKey, 'https://storage.babbage.systems');
            setAuth({
              isAuthenticated: true,
              method: 'privateKey',
              wallet
            });
          } else if (authData.method === 'wallet') {
            // For wallet login, would need to reconnect to WalletClient
            // For now, just clear the session as we can't restore WalletClient
            sessionStorage.removeItem(SESSION_KEY);
            sessionStorage.removeItem(PRIVATE_KEY_SESSION_KEY);
          }
        }
      } catch (error) {
        console.error('Failed to restore session:', error);
        sessionStorage.removeItem(SESSION_KEY);
        sessionStorage.removeItem(PRIVATE_KEY_SESSION_KEY);
      } finally {
        setIsInitializing(false);
      }
    };

    restoreSession();
  }, []);

  const login = (method: AuthMethod, wallet?: WalletInterface, privateKey?: string) => {
    const authState = {
      isAuthenticated: true,
      method,
      wallet
    };

    setAuth(authState);

    // Store in session storage
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({ method }));

    // Store private key if provided (only for privateKey method)
    if (method === 'privateKey' && privateKey) {
      sessionStorage.setItem(PRIVATE_KEY_SESSION_KEY, privateKey);
    }
  };

  const logout = () => {
    setAuth({ isAuthenticated: false });
    sessionStorage.removeItem(SESSION_KEY);
    sessionStorage.removeItem(PRIVATE_KEY_SESSION_KEY);
  };

  // Don't render children until we've attempted to restore the session
  if (isInitializing) {
    return null;
  }

  return (
    <AuthContext.Provider value={{ auth, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
