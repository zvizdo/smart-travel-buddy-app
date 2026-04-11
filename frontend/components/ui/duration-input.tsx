"use client";

import { useEffect, useRef, useState } from "react";

interface DurationInputProps {
  label?: string;
  value: number | null;
  onChange: (minutes: number | null) => void;
  placeholder?: string;
}

const PRESETS: { label: string; minutes: number }[] = [
  { label: "30m", minutes: 30 },
  { label: "1h", minutes: 60 },
  { label: "2h", minutes: 120 },
  { label: "4h", minutes: 240 },
  { label: "1 night", minutes: 60 * 24 },
  { label: "2 nights", minutes: 60 * 24 * 2 },
];

export function parseDurationString(raw: string): number | null {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;

  const nightMatch = trimmed.match(/^(\d+)\s*nights?$/);
  if (nightMatch) {
    const nights = parseInt(nightMatch[1], 10);
    if (nights <= 0) return null;
    return nights * 60 * 24;
  }

  const hmMatch = trimmed.match(/^(\d+)\s*h(?:\s*(\d+)\s*m?)?$/);
  if (hmMatch) {
    const hours = parseInt(hmMatch[1], 10);
    const minutes = hmMatch[2] ? parseInt(hmMatch[2], 10) : 0;
    const total = hours * 60 + minutes;
    return total > 0 ? total : null;
  }

  const minMatch = trimmed.match(/^(\d+)\s*m(?:in)?$/);
  if (minMatch) {
    const minutes = parseInt(minMatch[1], 10);
    return minutes > 0 ? minutes : null;
  }

  const bareNum = trimmed.match(/^(\d+)$/);
  if (bareNum) {
    const minutes = parseInt(bareNum[1], 10);
    return minutes > 0 ? minutes : null;
  }

  return null;
}

export function formatDurationMinutes(minutes: number | null): string {
  if (minutes == null || minutes <= 0) return "";
  if (minutes < 60) return `${minutes}m`;
  const days = Math.floor(minutes / (60 * 24));
  const remAfterDays = minutes - days * 60 * 24;
  if (days >= 1 && remAfterDays === 0) {
    return days === 1 ? "1 night" : `${days} nights`;
  }
  const hours = Math.floor(minutes / 60);
  const mins = minutes - hours * 60;
  if (mins === 0) return `${hours}h`;
  return `${hours}h ${mins}m`;
}

export function DurationInput({
  label = "Duration",
  value,
  onChange,
  placeholder = "e.g. 2h, 30m, 1 night",
}: DurationInputProps) {
  const [text, setText] = useState(() => formatDurationMinutes(value));
  const [error, setError] = useState(false);
  const lastCommittedRef = useRef<number | null>(value);

  useEffect(() => {
    if (value !== lastCommittedRef.current) {
      setText(formatDurationMinutes(value));
      lastCommittedRef.current = value;
      setError(false);
    }
  }, [value]);

  function commit(raw: string) {
    if (raw.trim() === "") {
      onChange(null);
      lastCommittedRef.current = null;
      setError(false);
      return;
    }
    const parsed = parseDurationString(raw);
    if (parsed == null) {
      setError(true);
      return;
    }
    onChange(parsed);
    lastCommittedRef.current = parsed;
    setText(formatDurationMinutes(parsed));
    setError(false);
  }

  function handlePreset(minutes: number) {
    onChange(minutes);
    lastCommittedRef.current = minutes;
    setText(formatDurationMinutes(minutes));
    setError(false);
  }

  return (
    <div>
      <label className="block text-[11px] font-medium text-on-surface-variant mb-1.5 uppercase tracking-wide">
        {label}
      </label>
      <div
        className={`rounded-2xl px-3 py-2.5 transition-all ${
          error
            ? "bg-error/8 ring-1.5 ring-error/40"
            : "bg-surface-lowest shadow-soft ring-1 ring-outline-variant/20"
        }`}
      >
        <div className="flex items-center gap-2.5">
          <div className="flex-shrink-0 h-8 w-8 rounded-xl bg-primary/10 flex items-center justify-center text-primary">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
          </div>
          <input
            type="text"
            inputMode="text"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setError(false);
            }}
            onBlur={(e) => commit(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commit((e.target as HTMLInputElement).value);
              }
            }}
            placeholder={placeholder}
            className="flex-1 bg-transparent text-sm text-on-surface placeholder:text-outline focus:outline-none"
          />
        </div>
      </div>
      {error && (
        <p className="mt-1 text-[11px] text-error px-1">
          Unrecognized duration. Try "2h", "30m", or "1 night".
        </p>
      )}
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {PRESETS.map((preset) => (
          <button
            key={preset.label}
            type="button"
            onClick={() => handlePreset(preset.minutes)}
            className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition-all active:scale-95 ${
              value === preset.minutes
                ? "bg-primary/15 text-primary"
                : "bg-surface-high text-on-surface-variant hover:bg-surface-low"
            }`}
          >
            {preset.label}
          </button>
        ))}
      </div>
    </div>
  );
}
