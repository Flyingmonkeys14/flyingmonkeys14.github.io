import { useEffect, useRef, useMemo } from "react";
import {
  Chart,
  LineController,
  LineElement,
  PointElement,
  LinearScale,
  TimeScale,
  Tooltip,
  Legend,
  Filler,
} from "chart.js";
import type { ParsedLog } from "../types";
import { getValueAtTime } from "../parsers/logUtils";

Chart.register(
  LineController,
  LineElement,
  PointElement,
  LinearScale,
  TimeScale,
  Tooltip,
  Legend,
  Filler
);

const COLORS = [
  "#60a5fa", "#f87171", "#4ade80", "#f59e0b",
  "#a78bfa", "#fb923c", "#34d399", "#e879f9",
  "#38bdf8", "#fbbf24", "#86efac", "#f472b6",
];

const STRING_BAND_COLORS = [
  "#3b82f6", "#ef4444", "#22c55e", "#f59e0b",
  "#8b5cf6", "#f97316", "#10b981", "#ec4899",
  "#06b6d4", "#84cc16", "#6366f1", "#14b8a6",
];

interface TimeChartProps {
  log: ParsedLog;
  selectedFields: Set<string>;
  currentTime: number;
  onTimeChange: (t: number) => void;
}

interface DataPoint {
  x: number;
  y: number;
}

export function TimeChart({ log, selectedFields, currentTime, onTimeChange }: TimeChartProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<Chart | null>(null);

  const { numericFields, stringFields } = useMemo(() => {
    const numeric: string[] = [];
    const strings: string[] = [];
    for (const key of selectedFields) {
      const f = log.fields[key];
      if (!f) continue;
      if (f.type === "Number" || f.type === "Boolean") numeric.push(key);
      else if (f.type === "String") strings.push(key);
    }
    return { numericFields: numeric, stringFields: strings };
  }, [selectedFields, log]);

  useEffect(() => {
    if (!canvasRef.current) return;
    if (chartRef.current) { chartRef.current.destroy(); chartRef.current = null; }
    if (numericFields.length === 0) return;

    const datasets = numericFields.map((key, i) => {
      const field = log.fields[key];
      const data: DataPoint[] = field.entries.map((e) => ({
        x: (e.timestamp - log.startTime) * 1000,
        y: typeof e.value === "boolean" ? (e.value ? 1 : 0) : (e.value as number),
      }));
      return {
        label: key.replace(/^\//, ""),
        data,
        borderColor: COLORS[i % COLORS.length],
        backgroundColor: COLORS[i % COLORS.length] + "22",
        borderWidth: 1.5,
        pointRadius: data.length > 500 ? 0 : 2,
        pointHoverRadius: 4,
        tension: 0,
        stepped: field.type === "Boolean" ? ("before" as const) : false,
      };
    });

    const stringBandData: { key: string; color: string; changes: { xMs: number; value: string }[] }[] = [];
    stringFields.forEach((key, si) => {
      const field = log.fields[key];
      const changes: { xMs: number; value: string }[] = [];
      let lastVal: string | null = null;
      for (const entry of field.entries) {
        const v = String(entry.value ?? "");
        if (v !== lastVal) {
          changes.push({ xMs: (entry.timestamp - log.startTime) * 1000, value: v });
          lastVal = v;
        }
      }
      stringBandData.push({ key, color: STRING_BAND_COLORS[si % STRING_BAND_COLORS.length], changes });
    });

    const BAND_H = 18;
    const BANDS_TOTAL = stringBandData.length * BAND_H;
    const STRING_PADDING_BOTTOM = BANDS_TOTAL > 0 ? BANDS_TOTAL + 8 : 0;

    chartRef.current = new Chart(canvasRef.current, {
      type: "line",
      data: { datasets },
      options: {
        animation: false,
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        layout: { padding: { bottom: STRING_PADDING_BOTTOM } },
        plugins: {
          legend: { position: "top", labels: { color: "#e2e8f0", boxWidth: 12, font: { size: 11 } } },
          tooltip: {
            callbacks: {
              title: (items) => {
                const ms = items[0]?.parsed.x ?? 0;
                return `T+${(ms / 1000).toFixed(3)}s`;
              },
            },
          },
        },
        scales: {
          x: {
            type: "linear",
            title: { display: true, text: "Time (ms from start)", color: "#94a3b8" },
            ticks: { color: "#94a3b8" },
            grid: { color: "#1e293b" },
          },
          y: { ticks: { color: "#94a3b8" }, grid: { color: "#1e293b" } },
        },
      },
      plugins: [
        {
          id: "timeCursor",
          afterDraw(chart) {
            const xScale = chart.scales["x"];
            const yScale = chart.scales["y"];
            if (!xScale || !yScale) return;
            const xMs = (currentTime - log.startTime) * 1000;
            const xPx = xScale.getPixelForValue(xMs);
            if (xPx < xScale.left || xPx > xScale.right) return;
            const ctx = chart.ctx;
            ctx.save();
            ctx.beginPath();
            ctx.moveTo(xPx, yScale.top);
            ctx.lineTo(xPx, chart.height - 4);
            ctx.strokeStyle = "#f59e0b";
            ctx.lineWidth = 1.5;
            ctx.setLineDash([4, 3]);
            ctx.stroke();
            ctx.restore();
          },
        },
        {
          id: "stringBands",
          afterDraw(chart) {
            if (stringBandData.length === 0) return;
            const xScale = chart.scales["x"];
            if (!xScale) return;
            const ctx = chart.ctx;
            const chartBottom = chart.height - 4;
            const xLeft = xScale.left;
            const xRight = xScale.right;
            const xMax = xScale.max;

            ctx.save();
            stringBandData.forEach((band, bi) => {
              const bandTop = chartBottom - BANDS_TOTAL + bi * BAND_H;
              const bandBottom = bandTop + BAND_H - 2;
              const valueColors = new Map<string, string>();
              const valuePalette = ["#1e3a5f", "#3b1e5f", "#1e5f3a", "#5f3b1e", "#1e4f5f", "#5f1e3a"];
              let palIdx = 0;
              for (const c of band.changes) {
                if (!valueColors.has(c.value)) { valueColors.set(c.value, valuePalette[palIdx % valuePalette.length]); palIdx++; }
              }
              for (let ci = 0; ci < band.changes.length; ci++) {
                const segStart = band.changes[ci].xMs;
                const segEnd = ci + 1 < band.changes.length ? band.changes[ci + 1].xMs : xMax;
                const px1 = Math.max(xLeft, xScale.getPixelForValue(segStart));
                const px2 = Math.min(xRight, xScale.getPixelForValue(segEnd));
                if (px2 <= px1) continue;
                const bgColor = valueColors.get(band.changes[ci].value) ?? "#333";
                ctx.fillStyle = bgColor;
                ctx.fillRect(px1, bandTop, px2 - px1, bandBottom - bandTop);
                const segWidth = px2 - px1;
                if (segWidth > 30) {
                  ctx.fillStyle = "#e2e8f0";
                  ctx.font = "9px sans-serif";
                  ctx.textBaseline = "middle";
                  ctx.save();
                  ctx.beginPath();
                  ctx.rect(px1, bandTop, segWidth, bandBottom - bandTop);
                  ctx.clip();
                  ctx.fillText(band.changes[ci].value, px1 + 3, (bandTop + bandBottom) / 2);
                  ctx.restore();
                }
              }
              ctx.strokeStyle = "#334155";
              ctx.lineWidth = 1;
              ctx.strokeRect(xLeft, bandTop, xRight - xLeft, bandBottom - bandTop);
              ctx.fillStyle = band.color;
              ctx.font = "bold 9px sans-serif";
              ctx.textBaseline = "middle";
              ctx.fillText(band.key.replace(/^\//, "").slice(-20), xLeft + 2, (bandTop + bandBottom) / 2);
              ctx.strokeStyle = band.color;
              ctx.lineWidth = 1;
              ctx.setLineDash([]);
              for (const c of band.changes) {
                const px = xScale.getPixelForValue(c.xMs);
                ctx.beginPath(); ctx.moveTo(px, bandTop); ctx.lineTo(px, bandBottom); ctx.stroke();
              }
            });
            ctx.restore();
          },
        },
      ],
    });

    const canvas = canvasRef.current;
    const handleClick = (e: MouseEvent) => {
      const chart = chartRef.current;
      if (!chart) return;
      const xScale = chart.scales["x"];
      if (!xScale) return;
      const rect = canvas.getBoundingClientRect();
      const xPx = e.clientX - rect.left;
      const xMs = xScale.getValueForPixel(xPx);
      if (xMs !== undefined) onTimeChange(log.startTime + xMs / 1000);
    };
    canvas.addEventListener("click", handleClick);
    return () => canvas.removeEventListener("click", handleClick);
  }, [numericFields, stringFields, log]);

  useEffect(() => { chartRef.current?.update("none"); }, [currentTime]);

  const hasNoPlottable = numericFields.length === 0;
  const hasStringOnly = hasNoPlottable && stringFields.length > 0;

  if (hasNoPlottable && selectedFields.size > 0 && !hasStringOnly) {
    return <div className="chart-empty">Selected fields are not numeric. Try selecting Number, Boolean, or String fields.</div>;
  }
  if (numericFields.length === 0 && stringFields.length === 0) {
    return <div className="chart-empty">Select fields from the sidebar to plot them here.</div>;
  }
  if (hasStringOnly) {
    return <StringTimeline log={log} stringFields={stringFields} currentTime={currentTime} onTimeChange={onTimeChange} />;
  }

  return <div className="chart-container"><canvas ref={canvasRef} /></div>;
}

function StringTimeline({ log, stringFields, currentTime, onTimeChange }: {
  log: ParsedLog; stringFields: string[]; currentTime: number; onTimeChange: (t: number) => void;
}) {
  const totalMs = (log.endTime - log.startTime) * 1000;
  return (
    <div className="string-timeline">
      {stringFields.map((key, si) => {
        const field = log.fields[key];
        const changes: { xMs: number; value: string }[] = [];
        let lastVal: string | null = null;
        for (const entry of field.entries) {
          const v = String(entry.value ?? "");
          if (v !== lastVal) { changes.push({ xMs: (entry.timestamp - log.startTime) * 1000, value: v }); lastVal = v; }
        }
        const color = STRING_BAND_COLORS[si % STRING_BAND_COLORS.length];
        const curMs = (currentTime - log.startTime) * 1000;
        return (
          <div key={key} className="string-lane">
            <div className="string-lane-label" style={{ color }}>{key.replace(/^\//, "")}</div>
            <div className="string-lane-track" onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              const frac = (e.clientX - rect.left) / rect.width;
              onTimeChange(log.startTime + frac * (log.endTime - log.startTime));
            }}>
              {changes.map((c, ci) => {
                const startPct = (c.xMs / totalMs) * 100;
                const endPct = ci + 1 < changes.length ? (changes[ci + 1].xMs / totalMs) * 100 : 100;
                return (
                  <div key={ci} className="string-segment" style={{
                    left: `${startPct}%`, width: `${endPct - startPct}%`,
                    background: `hsl(${(si * 73 + ci * 37) % 360},45%,25%)`,
                    borderLeft: `2px solid ${color}`,
                  }} title={c.value}>
                    <span className="string-segment-label">{c.value}</span>
                  </div>
                );
              })}
              <div className="string-cursor" style={{ left: `${Math.min(100, (curMs / totalMs) * 100)}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

interface ValueTableProps {
  log: ParsedLog;
  selectedFields: Set<string>;
  currentTime: number;
}

export function ValueTable({ log, selectedFields, currentTime }: ValueTableProps) {
  if (selectedFields.size === 0) return null;
  return (
    <div className="value-table">
      <table>
        <thead>
          <tr>
            <th>Field</th>
            <th>Type</th>
            <th>Value @ {(currentTime - log.startTime).toFixed(3)}s</th>
          </tr>
        </thead>
        <tbody>
          {Array.from(selectedFields).map((key) => {
            const field = log.fields[key];
            if (!field) return null;
            const value = getValueAtTime(field, currentTime);
            return (
              <tr key={key}>
                <td className="field-key">{key.replace(/^\//, "")}</td>
                <td className="field-type">{field.typeStr}</td>
                <td className="field-value">{formatTableValue(value)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function formatTableValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (value instanceof Uint8Array) {
    return `[${Array.from(value.slice(0, 16)).map((b) => b.toString(16).padStart(2, "0")).join(" ")}${value.length > 16 ? "…" : ""}]`;
  }
  if (Array.isArray(value)) {
    const preview = value.slice(0, 8).map(String).join(", ");
    return `[${preview}${value.length > 8 ? ", …" : ""}]`;
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    return Number.isInteger(value) ? String(value) : value.toPrecision(7).replace(/\.?0+$/, "");
  }
  return String(value);
}
