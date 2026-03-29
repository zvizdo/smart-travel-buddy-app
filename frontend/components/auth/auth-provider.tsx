"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import {
  onAuthStateChanged,
  signInWithPopup,
  signOut as firebaseSignOut,
  type User,
  type AuthProvider as FirebaseAuthProvider,
} from "firebase/auth";
import {
  getFirebaseAuth,
  googleProvider,
  appleProvider,
  yahooProvider,
} from "@/lib/firebase";

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  signInWithGoogle: () => Promise<void>;
  signInWithApple: () => Promise<void>;
  signInWithYahoo: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return ctx;
}

async function signInWith(provider: FirebaseAuthProvider) {
  const auth = getFirebaseAuth();
  await signInWithPopup(auth, provider);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const auth = getFirebaseAuth();
    const unsub = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setLoading(false);
    });
    return unsub;
  }, []);

  const value: AuthContextValue = {
    user,
    loading,
    signInWithGoogle: () => signInWith(googleProvider),
    signInWithApple: () => signInWith(appleProvider),
    signInWithYahoo: () => signInWith(yahooProvider),
    signOut: async () => {
      const auth = getFirebaseAuth();
      await firebaseSignOut(auth);
    },
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
