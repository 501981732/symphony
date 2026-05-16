import { cn } from "../../lib/cn";

interface SparklineProps {
  values: number[];
  width?: number;
  height?: number;
  stroke?: string;
  fill?: string;
  className?: string;
  label?: string;
}

/**
 * Inline SVG sparkline. Kept dependency-free so the dashboard
 * bundle does not pull in chart libs (Quick Reference §3 — bundle
 * size). Renders as an aria-labelled image; values are also
 * surfaced separately in the surrounding markup for screen readers.
 */
export function Sparkline({
  values,
  width = 96,
  height = 28,
  stroke = "currentColor",
  fill = "none",
  className,
  label,
}: SparklineProps) {
  if (values.length === 0) {
    return (
      <span
        className={cn("inline-block text-fg-subtle", className)}
        aria-label={label ?? "no data"}
      >
        —
      </span>
    );
  }
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = Math.max(max - min, 1);
  const stepX = values.length > 1 ? width / (values.length - 1) : width;

  const points = values
    .map((v, i) => {
      const x = i * stepX;
      const y = height - ((v - min) / range) * height;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      role="img"
      aria-label={label ?? `trend over ${values.length} points`}
      className={cn("overflow-visible", className)}
    >
      {fill !== "none" ? (
        <polygon
          points={`0,${height} ${points} ${width},${height}`}
          fill={fill}
          stroke="none"
        />
      ) : null}
      <polyline
        points={points}
        fill="none"
        stroke={stroke}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

interface BarsProps {
  values: { label: string; value: number }[];
  height?: number;
  className?: string;
  tone?: string;
  ariaLabel?: string;
}

/**
 * Horizontal bar mini-chart used for the Reports trend card.
 * Each bar gets `aria-label` so screen readers get the value
 * even without hovering (Quick Reference §10 `tooltip-keyboard`).
 */
export function MiniBars({
  values,
  height = 96,
  className,
  tone = "hsl(var(--color-info))",
  ariaLabel,
}: BarsProps) {
  if (values.length === 0) {
    return (
      <p className={cn("text-sm text-fg-subtle", className)}>No data yet.</p>
    );
  }
  const max = Math.max(...values.map((v) => v.value), 1);

  return (
    <div className={cn("flex flex-col gap-2", className)} aria-label={ariaLabel}>
      <div
        className="grid items-end gap-1"
        style={{
          gridTemplateColumns: `repeat(${values.length}, minmax(0, 1fr))`,
          height,
        }}
      >
        {values.map((v) => {
          const h = max === 0 ? 0 : (v.value / max) * height;
          return (
            <div
              key={`${v.label}`}
              role="img"
              aria-label={`${v.label}: ${v.value}`}
              className="relative flex h-full items-end"
            >
              <span
                className="block w-full rounded-sm transition-all duration-300 ease-swiss-out"
                style={{
                  height: `${Math.max(h, 2)}px`,
                  backgroundColor: tone,
                  opacity: v.value === 0 ? 0.25 : 0.9,
                }}
              />
            </div>
          );
        })}
      </div>
      <div
        className="grid font-mono text-[10px] uppercase tracking-[0.14em] text-fg-subtle"
        style={{
          gridTemplateColumns: `repeat(${values.length}, minmax(0, 1fr))`,
        }}
      >
        {values.map((v) => (
          <span key={`${v.label}-label`} className="truncate text-center">
            {v.label}
          </span>
        ))}
      </div>
    </div>
  );
}

interface DonutSegment {
  label: string;
  value: number;
  color: string;
}

interface DonutProps {
  segments: DonutSegment[];
  size?: number;
  thickness?: number;
  className?: string;
}

/**
 * Mini donut chart for the "Merge readiness mix" card. Segments
 * collapse to a single muted ring when total is zero so the empty
 * state is still recognisable as a chart (Quick Reference §10
 * `empty-data-state`).
 */
export function Donut({
  segments,
  size = 144,
  thickness = 18,
  className,
}: DonutProps) {
  const total = segments.reduce((s, x) => s + x.value, 0);
  const radius = size / 2 - thickness / 2;
  const circumference = 2 * Math.PI * radius;

  if (total === 0) {
    return (
      <svg
        viewBox={`0 0 ${size} ${size}`}
        width={size}
        height={size}
        className={className}
        role="img"
        aria-label="no readiness data yet"
      >
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          stroke="hsl(var(--color-border))"
          strokeWidth={thickness}
          fill="none"
        />
      </svg>
    );
  }

  let offset = 0;
  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      width={size}
      height={size}
      className={className}
      role="img"
      aria-label={`readiness mix across ${total} reports`}
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        stroke="hsl(var(--color-surface-3))"
        strokeWidth={thickness}
        fill="none"
      />
      {segments.map((seg) => {
        if (seg.value === 0) return null;
        const dash = (seg.value / total) * circumference;
        const el = (
          <circle
            key={seg.label}
            cx={size / 2}
            cy={size / 2}
            r={radius}
            stroke={seg.color}
            strokeWidth={thickness}
            fill="none"
            strokeDasharray={`${dash} ${circumference - dash}`}
            strokeDashoffset={-offset}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
          >
            <title>{`${seg.label}: ${seg.value}`}</title>
          </circle>
        );
        offset += dash;
        return el;
      })}
    </svg>
  );
}
