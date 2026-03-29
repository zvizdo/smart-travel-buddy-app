"use client";

interface PathFilterProps {
  mode: "all" | "mine";
  onModeChange: (mode: "all" | "mine") => void;
}

export function PathFilter({ mode, onModeChange }: PathFilterProps) {
  return (
    <div className="absolute top-20 right-3 z-10 flex rounded-full glass-panel-dense shadow-soft overflow-hidden">
      <button
        onClick={() => onModeChange("mine")}
        className={`px-4 py-2 text-xs font-semibold transition-all ${
          mode === "mine"
            ? "gradient-primary text-on-primary"
            : "text-on-surface-variant hover:text-on-surface"
        }`}
      >
        My Path
      </button>
      <button
        onClick={() => onModeChange("all")}
        className={`px-4 py-2 text-xs font-semibold transition-all ${
          mode === "all"
            ? "gradient-primary text-on-primary"
            : "text-on-surface-variant hover:text-on-surface"
        }`}
      >
        All Paths
      </button>
    </div>
  );
}
