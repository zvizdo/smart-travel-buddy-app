import { describe, it, expect } from "vitest";
import { parseDurationString, formatDurationMinutes } from "./duration-input";

describe("parseDurationString", () => {
  it("parses hour-minute combinations", () => {
    expect(parseDurationString("2h")).toBe(120);
    expect(parseDurationString("2h 30m")).toBe(150);
    expect(parseDurationString("2h30m")).toBe(150);
    expect(parseDurationString("2h30")).toBe(150);
  });

  it("parses minutes", () => {
    expect(parseDurationString("30m")).toBe(30);
    expect(parseDurationString("45min")).toBe(45);
  });

  it("parses nights as multiples of 24 hours", () => {
    expect(parseDurationString("1 night")).toBe(24 * 60);
    expect(parseDurationString("2 nights")).toBe(48 * 60);
    expect(parseDurationString("3nights")).toBe(72 * 60);
  });

  it("parses bare integers as minutes", () => {
    expect(parseDurationString("90")).toBe(90);
  });

  it("is case-insensitive", () => {
    expect(parseDurationString("2H 30M")).toBe(150);
    expect(parseDurationString("1 NIGHT")).toBe(24 * 60);
  });

  it("rejects empty, nonsense, and zero", () => {
    expect(parseDurationString("")).toBeNull();
    expect(parseDurationString("abc")).toBeNull();
    expect(parseDurationString("0")).toBeNull();
    expect(parseDurationString("0h")).toBeNull();
  });

  it("rejects single letter 'n'", () => {
    expect(parseDurationString("1n")).toBeNull();
  });
});

describe("formatDurationMinutes", () => {
  it("formats minutes under an hour", () => {
    expect(formatDurationMinutes(30)).toBe("30m");
    expect(formatDurationMinutes(45)).toBe("45m");
  });

  it("formats whole hours without minutes", () => {
    expect(formatDurationMinutes(60)).toBe("1h");
    expect(formatDurationMinutes(120)).toBe("2h");
  });

  it("formats hours and minutes together", () => {
    expect(formatDurationMinutes(90)).toBe("1h 30m");
    expect(formatDurationMinutes(150)).toBe("2h 30m");
  });

  it("formats whole nights", () => {
    expect(formatDurationMinutes(24 * 60)).toBe("1 night");
    expect(formatDurationMinutes(48 * 60)).toBe("2 nights");
  });

  it("returns empty string for null/zero/negative", () => {
    expect(formatDurationMinutes(null)).toBe("");
    expect(formatDurationMinutes(0)).toBe("");
    expect(formatDurationMinutes(-5)).toBe("");
  });

  it("parse → format → parse round-trip is stable for presets", () => {
    const presets = [30, 60, 120, 240, 24 * 60, 48 * 60];
    for (const minutes of presets) {
      const formatted = formatDurationMinutes(minutes);
      expect(parseDurationString(formatted)).toBe(minutes);
    }
  });
});
