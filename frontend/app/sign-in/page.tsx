"use client";

import { useAuth } from "@/components/auth/auth-provider";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

export default function SignInPage() {
  const { user, loading, signInWithGoogle, signInWithApple, signInWithYahoo } =
    useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && user) {
      router.replace("/");
    }
  }, [user, loading, router]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface">
        <div className="h-8 w-8 animate-spin rounded-full border-3 border-surface-high border-t-primary" />
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-surface px-6">
      {/* Hero Section */}
      <div className="text-center mb-12">
        <div className="w-20 h-20 rounded-3xl gradient-primary flex items-center justify-center mx-auto mb-6 shadow-ambient">
          <svg
            className="h-10 w-10 text-on-primary"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={1.5}
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M9 6.75V15m6-6v8.25m.503 3.498 4.875-2.437c.381-.19.622-.58.622-1.006V4.82c0-.836-.88-1.38-1.628-1.006l-3.869 1.934c-.317.159-.69.159-1.006 0L9.503 3.252a1.125 1.125 0 0 0-1.006 0L3.622 5.689C3.24 5.88 3 6.27 3 6.695V19.18c0 .836.88 1.38 1.628 1.006l3.869-1.934c.317-.159.69-.159 1.006 0l4.994 2.497c.317.158.69.158 1.006 0Z"
            />
          </svg>
        </div>
        <h1 className="text-3xl font-bold text-on-surface mb-2">
          Travel Buddy
        </h1>
        <p className="text-on-surface-variant">
          Plan adventures together, effortlessly
        </p>
      </div>

      {/* Sign-in Buttons */}
      <div className="flex flex-col gap-3 w-full max-w-sm">
        <button
          onClick={signInWithGoogle}
          className="flex items-center justify-center gap-3 rounded-2xl bg-surface-lowest px-5 py-4 font-medium text-on-surface shadow-soft transition-all active:scale-[0.98] hover:shadow-ambient"
        >
          <svg className="h-5 w-5" viewBox="0 0 24 24">
            <path
              fill="#4285F4"
              d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
            />
            <path
              fill="#34A853"
              d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
            />
            <path
              fill="#FBBC05"
              d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
            />
            <path
              fill="#EA4335"
              d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
            />
          </svg>
          Continue with Google
        </button>

        <button
          onClick={signInWithApple}
          className="flex items-center justify-center gap-3 rounded-2xl bg-inverse-surface px-5 py-4 font-medium text-surface-lowest transition-all active:scale-[0.98]"
        >
          <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 24 24">
            <path d="M17.05 20.28c-.98.95-2.05.88-3.08.4-1.09-.5-2.08-.48-3.24 0-1.44.62-2.2.44-3.06-.4C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z" />
          </svg>
          Continue with Apple
        </button>

        <button
          onClick={signInWithYahoo}
          className="flex items-center justify-center gap-3 rounded-2xl bg-[#6001D2] px-5 py-4 font-medium text-white transition-all active:scale-[0.98]"
        >
          <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 24 24">
            <path d="M13.31 9.46l3.07-6.73h-2.62l-1.88 4.45-1.88-4.45H7.38l3.07 6.73-.12.28c-.44 1.02-.8 1.36-1.63 1.36-.35 0-.72-.07-1.03-.18l-.6 2.06c.48.17 1.02.26 1.56.26 1.8 0 2.76-.84 3.62-2.82l3.93-8.92h.02l-2.84 7.95zm-1.44 4.27c-.82 0-1.49.67-1.49 1.49s.67 1.49 1.49 1.49 1.49-.67 1.49-1.49-.67-1.49-1.49-1.49z" />
          </svg>
          Continue with Yahoo
        </button>
      </div>
    </div>
  );
}
