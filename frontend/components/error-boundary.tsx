"use client";

import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
  onRetry?: () => void;
  fallback?: (error: Error, retry: () => void) => ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("ErrorBoundary caught:", error, info.componentStack);
  }

  private retry = () => {
    this.setState({ error: null });
    this.props.onRetry?.();
  };

  render() {
    if (this.state.error) {
      if (this.props.fallback) {
        return this.props.fallback(this.state.error, this.retry);
      }
      return (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 bg-surface p-6 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-error-container text-on-error-container">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
          </div>
          <div>
            <p className="text-base font-semibold text-on-surface">Something went wrong</p>
            <p className="mt-1 text-sm text-on-surface-variant">{this.state.error.message || "We hit an unexpected error loading this trip."}</p>
          </div>
          <button
            type="button"
            onClick={this.retry}
            className="rounded-full bg-primary px-5 py-2 text-sm font-medium text-on-primary shadow-soft active:scale-[0.98]"
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
