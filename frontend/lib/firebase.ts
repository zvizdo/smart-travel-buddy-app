"use client";

import { initializeApp, getApps, FirebaseApp } from "firebase/app";
import {
  getAuth,
  Auth,
  GoogleAuthProvider,
  OAuthProvider,
} from "firebase/auth";
import {
  getFirestore as getFirestoreInstance,
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  Firestore,
} from "firebase/firestore";

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
};

let app: FirebaseApp;
let authInstance: Auth;
let db: Firestore;

function getFirebaseApp(): FirebaseApp {
  if (!app) {
    const existing = getApps();
    app =
      existing.length > 0
        ? existing[0]
        : initializeApp(firebaseConfig);
  }
  return app;
}

export function getFirebaseAuth(): Auth {
  if (!authInstance) {
    authInstance = getAuth(getFirebaseApp());
  }
  return authInstance;
}

export function getFirestore(): Firestore {
  if (!db) {
    const firebaseApp = getFirebaseApp();
    try {
      // First call: initialize with persistent cache
      db = initializeFirestore(firebaseApp, {
        localCache: persistentLocalCache({
          tabManager: persistentMultipleTabManager(),
        }),
      });
    } catch {
      // Already initialized (e.g. hot reload) — get existing instance
      db = getFirestoreInstance(firebaseApp);
    }
  }
  return db;
}

export const googleProvider = new GoogleAuthProvider();
export const appleProvider = new OAuthProvider("apple.com");
export const yahooProvider = new OAuthProvider("yahoo.com");
