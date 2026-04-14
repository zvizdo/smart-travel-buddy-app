export type SpinnerSize = "xs" | "sm" | "md" | "lg";

export type SpinnerVariant = "primary" | "on-primary" | "error" | "current";

interface SpinnerProps {
  size?: SpinnerSize;
  variant?: SpinnerVariant;
  inline?: boolean;
  className?: string;
  "aria-label"?: string;
}

const SIZE_CLASSES: Record<SpinnerSize, string> = {
  xs: "h-3.5 w-3.5 border-2",
  sm: "h-4 w-4 border-2",
  md: "h-5 w-5 border-2",
  lg: "h-8 w-8 border-3",
};

const VARIANT_CLASSES: Record<SpinnerVariant, string> = {
  primary: "border-surface-high border-t-primary",
  "on-primary": "border-on-primary/30 border-t-on-primary",
  error: "border-surface-high border-t-error",
  current: "border-current/30 border-t-current",
};

export function Spinner({
  size = "md",
  variant = "primary",
  inline = false,
  className,
  "aria-label": ariaLabel = "Loading",
}: SpinnerProps) {
  const wrapper = inline ? "inline-flex" : "flex";
  return (
    <span
      role="status"
      aria-label={ariaLabel}
      className={`${wrapper} items-center justify-center ${className ?? ""}`}
    >
      <span
        className={`animate-spin rounded-full ${SIZE_CLASSES[size]} ${VARIANT_CLASSES[variant]}`}
      />
    </span>
  );
}
