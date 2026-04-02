const MODE_COLORS: Record<string, string> = {
  drive: "#006479",
  flight: "#5e35b1",
  transit: "#9a7c00",
  walk: "#006b1b",
};

interface TravelModeIconProps {
  mode: string;
  size?: number;
  className?: string;
}

export function TravelModeIcon({ mode, size = 18, className }: TravelModeIconProps) {
  const color = MODE_COLORS[mode] ?? "#707978";
  const s = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: color,
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    className,
  };
  switch (mode) {
    case "flight":
      return (
        <svg {...s}>
          <path d="M17.8 19.2 16 11l3.5-3.5C21 6 21 4 19 4s-2 1-3.5 2.5L11 8.2 4.8 6.4c-.7-.3-1.2 0-1.4.7L3 8l5.5 2.5L6.5 14l-2-.5-.8 2 3 1.5 1.5 3 2-.8-.5-2 3.5-2L19 22z" />
        </svg>
      );
    case "transit":
      return (
        <svg {...s}>
          <rect width="16" height="16" x="4" y="3" rx="2" />
          <path d="M4 11h16M12 3v8" />
          <circle cx="8.5" cy="17" r="1.5" fill={color} stroke="none" />
          <circle cx="15.5" cy="17" r="1.5" fill={color} stroke="none" />
        </svg>
      );
    case "walk":
      return (
        <svg {...s}>
          <circle cx="13" cy="4" r="1" fill={color} stroke="none" />
          <path d="m7 21 1-4m6 4-1-4M9 8.5 7 21M5 9l4-1 1 4 4 2" />
        </svg>
      );
    default:
      return (
        <svg {...s}>
          <path d="M19 17H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h11l4 4v4a2 2 0 0 1-2 2z" />
          <circle cx="7" cy="17" r="2" />
          <circle cx="17" cy="17" r="2" />
        </svg>
      );
  }
}

export { MODE_COLORS };
