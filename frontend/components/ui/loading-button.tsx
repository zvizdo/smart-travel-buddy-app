"use client";

import { useEffect, useState, type ButtonHTMLAttributes } from "react";
import { Spinner, type SpinnerSize, type SpinnerVariant } from "./spinner";

interface LoadingButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  loading?: boolean;
  /**
   * Delay in ms before the spinner appears. If `loading` flips back to false
   * before this elapses, no spinner is ever shown — prevents flash on fast
   * Firestore-only mutations. Default 300.
   */
  minLoadingMs?: number;
  spinnerVariant?: SpinnerVariant;
  spinnerSize?: SpinnerSize;
}

export function LoadingButton({
  loading = false,
  minLoadingMs = 300,
  spinnerVariant = "on-primary",
  spinnerSize = "sm",
  children,
  disabled,
  className,
  type = "button",
  ...rest
}: LoadingButtonProps) {
  const [displayLoading, setDisplayLoading] = useState(false);

  useEffect(() => {
    if (!loading) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDisplayLoading(false);
      return;
    }
    const timer = setTimeout(() => {
      setDisplayLoading(true);
    }, minLoadingMs);
    return () => clearTimeout(timer);
  }, [loading, minLoadingMs]);

  const isDisabled = loading || disabled;

  return (
    <button
      type={type}
      disabled={isDisabled}
      aria-busy={displayLoading}
      className={`relative ${className ?? ""}`}
      {...rest}
    >
      <span className={displayLoading ? "invisible" : undefined}>{children}</span>
      {displayLoading && (
        <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <Spinner size={spinnerSize} variant={spinnerVariant} />
        </span>
      )}
    </button>
  );
}
