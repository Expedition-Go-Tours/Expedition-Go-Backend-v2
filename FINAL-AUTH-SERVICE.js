// ============================================================================
// EXPEDITION GO - AUTHENTICATION SERVICE
// Last Updated: May 12, 2026
// CRITICAL: This file MUST replace your current auth service
// ============================================================================

import { initializeApp } from 'firebase/app';
import {
  getAuth,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signInWithPopup,
  GoogleAuthProvider,
  signOut as firebaseSignOut,
  onAuthStateChanged,
  updateProfile,
} from 'firebase/auth';

// ============================================================================
// CONFIGURATION
// ============================================================================

const AUTH_PROVIDER = import.meta.env.VITE_AUTH_PROVIDER || 'mock';
const AUTH_USER_KEY = 'expedition_go_auth_user';

// Backend API base URL
const rawBase = (
  import.meta.env.VITE_AUTH_API_BASE_URL ||
  import.meta.env.VITE_API_URL ||
  '/api'
);

let API_BASE = rawBase.replace(/\/+$/, '');

// Append /api if needed
if (/^https?:\/\/[^\/]+$/.test(API_BASE)) {
  API_BASE = `${API_BASE}/api`;
}

console.log('🔧 Auth Service Config:', {
  provider: AUTH_PROVIDER,
  apiBase: API_BASE,
});

// Firebase configuration
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
};

// Initialize Firebase
let app = null;
let auth = null;
let googleProvider = null;

if (AUTH_PROVIDER === 'firebase') {
  try {
    app = initializeApp(firebaseConfig);
    auth = getAuth(app);
    googleProvider = new GoogleAuthProvider();
    googleProvider.setCustomParameters({ prompt: 'select_account' });
    console.log('✅ Firebase initialized');
  } catch (error) {
    console.error('❌ Firebase initialization error:', error);
  }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

export function getAuthProvider() {
  return AUTH_PROVIDER;
}

function storeAuthUser(user) {
  try {
    if (user) localStorage.setItem(AUTH_USER_KEY, JSON.stringify(user));
    else localStorage.removeItem(AUTH_USER_KEY);
  } catch (error) {
    console.error('Failed to store user:', error);
  }
}

export function getStoredAuthUser() {
  try {
    const stored = localStorage.getItem(AUTH_USER_KEY);
    return stored ? JSON.parse(stored) : null;
  } catch (error) {
    console.error('Failed to get stored user:', error);
    return null;
  }
}

function removeAuthUser() {
  try {
    localStorage.removeItem(AUTH_USER_KEY);
  } catch (error) {
    console.error('Failed to remove user:', error);
  }
}

let authStateListeners = [];

function notifyAuthStateChange(user) {
  authStateListeners.forEach((l) => l(user));
}

// ============================================================================
// BACKEND API CALLS
// ============================================================================

/**
 * ⚠️ CRITICAL: ONLY USE THIS ENDPOINT
 * 
 * Call backend signup endpoint: POST /api/users/signup
 * - Idempotent (safe to call multiple times)
 * - Creates user if doesn't exist
 * - Returns existing user if already exists
 * - Does NOT require protect middleware
 * - Handles Firebase token verification internally
 */
async function callBackendSignup(idToken, firebaseUser) {
  const endpoint = `${API_BASE}/users/signup`;
  
  console.log('📡 Calling backend signup:', endpoint);
  
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${idToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: firebaseUser.displayName || firebaseUser.email?.split('@')[0],
      email: firebaseUser.email,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error('❌ Backend signup failed:', res.status, text);
    throw new Error(`Backend signup failed: ${res.status} ${text}`);
  }

  const payload = await res.json();
  console.log('✅ Backend signup successful');
  
  // Backend returns: { status: 'success', data: { user: {...} } }
  return payload.data.user;
}

/**
 * Sync user profile with backend (for updates only)
 * ⚠️ ONLY use this for profile updates, NOT for initial signup
 */
async function callBackendSyncMe(idToken, firebaseUser) {
  const res = await fetch(`${API_BASE}/users/sync-me`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${idToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: firebaseUser.displayName,
      email: firebaseUser.email,
      photoURL: firebaseUser.photoURL,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Backend sync-me failed: ${res.status} ${text}`);
  }

  const payload = await res.json();
  return payload.data.user;
}

function normalizeFirebaseClientUser(firebaseUser) {
  if (!firebaseUser) return null;
  return {
    uid: firebaseUser.uid,
    email: firebaseUser.email,
    emailVerified: firebaseUser.emailVerified,
    name: firebaseUser.displayName || firebaseUser.email?.split('@')[0] || 'User',
    photoURL: firebaseUser.photoURL || null,
    provider: firebaseUser.providerData?.[0]?.providerId || 'email',
  };
}

// ============================================================================
// AUTHENTICATION STATE MANAGEMENT
// ============================================================================

export async function subscribeToAuthState(callback) {
  authStateListeners.push(callback);

  if (AUTH_PROVIDER === 'firebase' && auth) {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      try {
        if (!firebaseUser) {
          removeAuthUser();
          notifyAuthStateChange(null);
          callback(null);
          return;
        }

        const idToken = await firebaseUser.getIdToken(false);

        // ⚠️ CRITICAL: ONLY call /signup endpoint
        // DO NOT call /create-me or /sync-me here
        let backendUser = null;
        try {
          backendUser = await callBackendSignup(idToken, firebaseUser);
        } catch (err) {
          console.error('Backend signup failed:', err);
          // Fallback to client-normalized user (offline mode)
          backendUser = normalizeFirebaseClientUser(firebaseUser);
        }

        storeAuthUser(backendUser);
        notifyAuthStateChange(backendUser);
        callback(backendUser);
      } catch (err) {
        console.error('Auth state handling error:', err);
        removeAuthUser();
        notifyAuthStateChange(null);
        callback(null);
      }
    });

    return () => {
      authStateListeners = authStateListeners.filter((l) => l !== callback);
      unsubscribe();
    };
  } else {
    // Mock mode
    const current = getStoredAuthUser();
    callback(current);
    return () => {
      authStateListeners = authStateListeners.filter((l) => l !== callback);
    };
  }
}

// ============================================================================
// AUTHENTICATION METHODS
// ============================================================================

export async function signInWithEmail(email, password) {
  if (AUTH_PROVIDER === 'firebase' && auth) {
    try {
      const credential = await signInWithEmailAndPassword(auth, email, password);
      const firebaseUser = credential.user;
      const idToken = await firebaseUser.getIdToken();

      // ⚠️ CRITICAL: Call /signup endpoint
      const backendUser = await callBackendSignup(idToken, firebaseUser);

      storeAuthUser(backendUser);
      notifyAuthStateChange(backendUser);
      return backendUser;
    } catch (error) {
      console.error('Firebase sign in error:', error);
      let message = 'Failed to sign in. Please try again.';
      if (error.code === 'auth/user-not-found')
        message = 'No account found with this email address.';
      else if (error.code === 'auth/wrong-password')
        message = 'Incorrect password. Please try again.';
      else if (error.code === 'auth/invalid-email')
        message = 'Invalid email address format.';
      else if (error.code === 'auth/user-disabled')
        message = 'This account has been disabled.';
      else if (error.code === 'auth/too-many-requests')
        message = 'Too many failed attempts. Please try again later.';
      else if (error.code === 'auth/invalid-credential')
        message = 'Invalid email or password.';
      throw new Error(message);
    }
  }

  // Mock sign-in
  await new Promise((r) => setTimeout(r, 800));
  const user = {
    id: 'mock-' + Date.now(),
    firebaseUid: 'mock-' + Date.now(),
    email,
    emailVerified: true,
    name: email.split('@')[0],
    provider: 'email',
  };
  storeAuthUser(user);
  notifyAuthStateChange(user);
  return user;
}

export async function registerWithEmail(name, email, password) {
  if (AUTH_PROVIDER === 'firebase' && auth) {
    try {
      console.log('🔐 Registering with Firebase...');
      const credential = await createUserWithEmailAndPassword(auth, email, password);
      
      // Update Firebase profile with name
      if (name) {
        await updateProfile(credential.user, { displayName: name });
        await credential.user.reload();
      }

      const firebaseUser = auth.currentUser;
      const idToken = await firebaseUser.getIdToken();

      console.log('📡 Creating user in backend...');
      // ⚠️ CRITICAL: Call /signup endpoint
      const backendUser = await callBackendSignup(idToken, firebaseUser);

      storeAuthUser(backendUser);
      notifyAuthStateChange(backendUser);
      console.log('✅ Registration complete!');
      return backendUser;
    } catch (error) {
      console.error('❌ Firebase registration error:', error);
      let message = 'Failed to create account. Please try again.';
      if (error.code === 'auth/email-already-in-use')
        message = 'An account with this email already exists.';
      else if (error.code === 'auth/invalid-email')
        message = 'Invalid email address format.';
      else if (error.code === 'auth/weak-password')
        message = 'Password is too weak. Please use at least 6 characters.';
      else if (error.code === 'auth/operation-not-allowed')
        message = 'Email/password accounts are not enabled.';
      throw new Error(message);
    }
  }

  // Mock registration
  await new Promise((r) => setTimeout(r, 1000));
  const user = {
    id: 'mock-' + Date.now(),
    firebaseUid: 'mock-' + Date.now(),
    email,
    emailVerified: false,
    name,
    provider: 'email',
  };
  storeAuthUser(user);
  notifyAuthStateChange(user);
  return user;
}

export async function signInWithGoogle() {
  if (AUTH_PROVIDER === 'firebase' && auth && googleProvider) {
    try {
      const result = await signInWithPopup(auth, googleProvider);
      const firebaseUser = result.user;
      const idToken = await firebaseUser.getIdToken();

      // ⚠️ CRITICAL: Call /signup endpoint
      const backendUser = await callBackendSignup(idToken, firebaseUser);

      storeAuthUser(backendUser);
      notifyAuthStateChange(backendUser);
      return backendUser;
    } catch (error) {
      console.error('Google sign in error:', error);
      let message = 'Failed to sign in with Google. Please try again.';
      if (error.code === 'auth/popup-closed-by-user')
        message = 'Sign in was cancelled. Please try again.';
      else if (error.code === 'auth/popup-blocked')
        message = 'Pop-up was blocked by your browser. Please allow pop-ups and try again.';
      else if (error.code === 'auth/account-exists-with-different-credential')
        message = 'An account already exists with the same email but different sign-in method.';
      else if (error.code === 'auth/operation-not-allowed')
        message = 'Google sign-in is not enabled.';
      throw new Error(message);
    }
  }

  // Mock Google sign-in
  await new Promise((r) => setTimeout(r, 1200));
  const user = {
    id: 'mock-google-' + Date.now(),
    firebaseUid: 'mock-google-' + Date.now(),
    email: 'user@gmail.com',
    emailVerified: true,
    name: 'Google User',
    photoURL: 'https://via.placeholder.com/150',
    provider: 'google.com',
  };
  storeAuthUser(user);
  notifyAuthStateChange(user);
  return user;
}

export async function signOutUser() {
  if (AUTH_PROVIDER === 'firebase' && auth) {
    try {
      await firebaseSignOut(auth);
      removeAuthUser();
      notifyAuthStateChange(null);
      return;
    } catch (error) {
      console.error('Firebase sign out error:', error);
      throw new Error('Failed to sign out. Please try again.');
    }
  }

  // Mock sign out
  await new Promise((r) => setTimeout(r, 300));
  removeAuthUser();
  notifyAuthStateChange(null);
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

export async function getCurrentUserToken() {
  if (AUTH_PROVIDER === 'firebase' && auth && auth.currentUser) {
    try {
      return await auth.currentUser.getIdToken();
    } catch (error) {
      console.error('Failed to get user token:', error);
      return null;
    }
  }
  return null;
}

/**
 * Get the API base URL for making API requests
 * Used by API client for constructing request URLs
 */
export function getApiBaseUrl() {
  return API_BASE;
}

/**
 * Get the current user's authentication token
 * Alias for getCurrentUserToken() - used by API client
 */
export async function getAuthToken() {
  return await getCurrentUserToken();
}

export async function updateUserProfile(updates) {
  if (AUTH_PROVIDER === 'firebase' && auth && auth.currentUser) {
    try {
      // Update Firebase profile
      if (updates.name || updates.photoURL) {
        await updateProfile(auth.currentUser, {
          displayName: updates.name,
          photoURL: updates.photoURL,
        });
      }

      const idToken = await auth.currentUser.getIdToken();

      // Sync with backend
      const backendUser = await callBackendSyncMe(idToken, auth.currentUser);

      storeAuthUser(backendUser);
      notifyAuthStateChange(backendUser);
      return backendUser;
    } catch (error) {
      console.error('Profile update error:', error);
      throw new Error('Failed to update profile. Please try again.');
    }
  }

  throw new Error('No authenticated user');
}

export { auth };
