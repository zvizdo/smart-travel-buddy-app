"use client";

import { useId } from "react";
import {
  localInputToUtc,
  formatDateTimeWithPreference,
  type DateFormatPreference,
} from "@/lib/dates";

interface DateTimePickerProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  datetimeFormat?: "12h" | "24h";
  dateFormat?: DateFormatPreference;
  timezone?: string;
  error?: boolean;
  errorMessage?: string;
  icon?: "arrival" | "departure";
}

export function DateTimePicker({
  label,
  value,
  onChange,
  datetimeFormat = "24h",
  dateFormat = "eu",
  timezone,
  error = false,
  errorMessage,
  icon = "arrival",
}: DateTimePickerProps) {
  const pickerId = useId();

  const hasValue = !!value;
  const utcValue = hasValue ? localInputToUtc(value, timezone) : null;
  const formatted = utcValue
    ? formatDateTimeWithPreference(utcValue, datetimeFormat, dateFormat, timezone)
    : null;

  // Split formatted string into date and time parts (separated by last comma)
  let datePart = "";
  let timePart = "";
  if (formatted) {
    const lastComma = formatted.lastIndexOf(",");
    if (lastComma !== -1) {
      datePart = formatted.slice(0, lastComma).trim();
      timePart = formatted.slice(lastComma + 1).trim();
    } else {
      datePart = formatted;
    }
  }

  return (
    <div>
      <label className="block text-[11px] font-medium text-on-surface-variant mb-1.5 uppercase tracking-wide">
        {label}
      </label>
      <div className="relative">
        <button
          type="button"
          onClick={() =>
            (document.getElementById(pickerId) as HTMLInputElement)?.showPicker()
          }
          className={`w-full rounded-2xl px-3 py-2.5 text-left transition-all ${
            error
              ? "bg-error/8 ring-1.5 ring-error/40"
              : hasValue
                ? "bg-surface-lowest shadow-soft ring-1 ring-outline-variant/20"
                : "bg-surface-high ring-1 ring-outline-variant/10"
          }`}
        >
          <div className="flex items-center gap-2.5">
            {/* Icon */}
            <div
              className={`flex-shrink-0 h-8 w-8 rounded-xl flex items-center justify-center ${
                error
                  ? "bg-error/12 text-error"
                  : hasValue
                    ? icon === "arrival"
                      ? "bg-primary/10 text-primary"
                      : "bg-tertiary/15 text-on-tertiary-container"
                    : "bg-surface-high text-outline"
              }`}
            >
              {icon === "arrival" ? (
                <svg
                  className="h-4 w-4"
                  fill="none"
                  viewBox="0 0 24 24"
                  strokeWidth={2}
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M9 3.75H6.912a2.25 2.25 0 0 0-2.15 1.588L2.35 13.177a2.25 2.25 0 0 0-.1.661V18a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18v-4.162c0-.224-.034-.447-.1-.661L19.24 5.338a2.25 2.25 0 0 0-2.15-1.588H15M2.25 13.5h3.86a2.25 2.25 0 0 1 2.012 1.244l.256.512a2.25 2.25 0 0 0 2.013 1.244h3.218a2.25 2.25 0 0 0 2.013-1.244l.256-.512a2.25 2.25 0 0 1 2.013-1.244h3.859M12 3v8.25m0 0-3-3m3 3 3-3"
                  />
                </svg>
              ) : (
                <svg
                  className="h-4 w-4"
                  fill="none"
                  viewBox="0 0 24 24"
                  strokeWidth={2}
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M6 12 3.269 3.125A59.769 59.769 0 0 1 21.485 12 59.768 59.768 0 0 1 3.27 20.875L5.999 12Zm0 0h7.5"
                  />
                </svg>
              )}
            </div>

            {/* Content */}
            {hasValue ? (
              <div className="flex-1 min-w-0">
                <p
                  className={`text-sm font-semibold leading-tight ${
                    error ? "text-error" : "text-on-surface"
                  }`}
                >
                  {datePart}
                </p>
                <p
                  className={`text-xs leading-tight mt-0.5 ${
                    error ? "text-error/70" : "text-on-surface-variant"
                  }`}
                >
                  {timePart}
                </p>
              </div>
            ) : (
              <span className="text-sm text-outline">Set {label.toLowerCase()}</span>
            )}
          </div>
        </button>
        <input
          id={pickerId}
          type="datetime-local"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="absolute inset-0 opacity-0 pointer-events-none"
          tabIndex={-1}
        />
      </div>
      {error && errorMessage && (
        <p className="text-xs text-error mt-1 ml-1">{errorMessage}</p>
      )}
    </div>
  );
}
