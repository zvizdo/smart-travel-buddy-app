"use client";

import { DateTimePicker } from "@/components/ui/datetime-picker";
import { DurationInput } from "@/components/ui/duration-input";
import { type DateFormatPreference } from "@/lib/dates";

export type TimingMode = "fixed" | "flexible";
export type FlexAnchor = "none" | "arrival" | "departure";

export interface TimingFieldsValue {
  mode: TimingMode;
  anchor: FlexAnchor;
  arrivalTime: string;
  departureTime: string;
  durationMinutes: number | null;
}

interface TimingFieldsSectionProps {
  value: TimingFieldsValue;
  onChange: (next: TimingFieldsValue) => void;
  isStartNode?: boolean;
  isEndNode?: boolean;
  datetimeFormat?: "12h" | "24h";
  dateFormat?: DateFormatPreference;
  showValidation?: boolean;
  timezone?: string | null;
}

export function TimingFieldsSection({
  value,
  onChange,
  isStartNode,
  isEndNode,
  datetimeFormat = "24h",
  dateFormat = "eu",
  showValidation,
  timezone,
}: TimingFieldsSectionProps) {
  const { mode, anchor, arrivalTime, departureTime, durationMinutes } = value;

  const departureBeforeArrival =
    !!arrivalTime && !!departureTime && departureTime <= arrivalTime;

  function setMode(m: TimingMode) {
    onChange({ ...value, mode: m });
  }

  function setAnchor(a: FlexAnchor) {
    onChange({ ...value, anchor: a });
  }

  function setArrivalTime(v: string) {
    const next = { ...value, arrivalTime: v };
    if (v && departureTime && v >= departureTime) {
      const d = new Date(v);
      d.setDate(d.getDate() + 1);
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, "0");
      const dd = String(d.getDate()).padStart(2, "0");
      const hh = String(d.getHours()).padStart(2, "0");
      const min = String(d.getMinutes()).padStart(2, "0");
      next.departureTime = `${yyyy}-${mm}-${dd}T${hh}:${min}`;
    }
    onChange(next);
  }

  function setDepartureTime(v: string) {
    onChange({ ...value, departureTime: v });
  }

  function setDurationMinutes(v: number | null) {
    onChange({ ...value, durationMinutes: v });
  }

  return (
    <>
      {/* Mode toggle */}
      <div>
        <div className="flex rounded-xl bg-surface-high p-0.5 gap-0.5">
          {(["fixed", "flexible"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={`flex-1 rounded-[10px] px-3 py-1.5 text-xs font-semibold transition-all ${
                mode === m
                  ? "bg-surface-lowest text-on-surface shadow-soft"
                  : "text-on-surface-variant"
              }`}
            >
              {m === "fixed" ? "Fixed time" : "Flexible duration"}
            </button>
          ))}
        </div>
      </div>

      {/* Timing inputs */}
      {mode === "fixed" ? (
        <div
          className={
            !isStartNode && !isEndNode
              ? "grid grid-cols-2 gap-2"
              : "space-y-2"
          }
        >
          {!isStartNode && (
            <DateTimePicker
              label="Arrival"
              value={arrivalTime}
              onChange={setArrivalTime}
              datetimeFormat={datetimeFormat}
              dateFormat={dateFormat}
              timezone={timezone ?? undefined}
              icon="arrival"
            />
          )}
          {!isEndNode && (
            <DateTimePicker
              label="Departure"
              value={departureTime}
              onChange={setDepartureTime}
              datetimeFormat={datetimeFormat}
              dateFormat={dateFormat}
              timezone={timezone ?? undefined}
              icon="departure"
              error={showValidation && departureBeforeArrival}
              errorMessage="Departure must be after arrival"
            />
          )}
        </div>
      ) : (
        <>
          {/* Anchor segmented control */}
          <div>
            <div className="flex rounded-xl bg-surface-high p-0.5 gap-0.5">
              {(
                [
                  { value: "none", label: "Float" },
                  { value: "arrival", label: "Know when I arrive" },
                  { value: "departure", label: "Know when I leave" },
                ] as { value: FlexAnchor; label: string }[]
              )
                .filter(({ value: v }) => {
                  if (v === "arrival" && isStartNode) return false;
                  if (v === "departure" && isEndNode) return false;
                  return true;
                })
                .map(({ value: v, label }) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setAnchor(v)}
                    className={`flex-1 rounded-[10px] px-2 py-1.5 text-[11px] font-semibold transition-all leading-tight ${
                      anchor === v
                        ? "bg-surface-lowest text-on-surface shadow-soft"
                        : "text-on-surface-variant"
                    }`}
                  >
                    {label}
                  </button>
                ))}
            </div>
          </div>

          {anchor === "arrival" && (
            <DateTimePicker
              label="Anchored arrival"
              value={arrivalTime}
              onChange={setArrivalTime}
              datetimeFormat={datetimeFormat}
              dateFormat={dateFormat}
              timezone={timezone ?? undefined}
              icon="arrival"
            />
          )}
          {anchor === "departure" && (
            <DateTimePicker
              label="Anchored departure"
              value={departureTime}
              onChange={setDepartureTime}
              datetimeFormat={datetimeFormat}
              dateFormat={dateFormat}
              timezone={timezone ?? undefined}
              icon="departure"
            />
          )}
          <DurationInput
            value={durationMinutes}
            onChange={setDurationMinutes}
          />
        </>
      )}
    </>
  );
}
