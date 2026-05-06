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

  const numericFields = useMemo(() => {
    return Array.from(selectedFields).filter((key) => {
      const f = log.fields[key];
      return f && (f.type === "Number" || f.type === "Boolean");
    });
  }, [selectedFields, log]);

  useEffect(() => {
    if (!canvasRef.current) return;

    if (chartRef.current) {
      chartRef.current.destroy();
      chartRef.current = null;
    }

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

    chartRef.current = new Chart(canvasRef.current, {
      type: "line",
      data: { datasets },
      options: {
        animation: false,
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: {
            position: "top",
            labels: { color: "#e2e8f0", boxWidth: 12, font: { size: 11 } },
          },
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
          y: {
            ticks: { color: "#94a3b8" },
            grid: { color: "#1e293b" },
          },
        },
        onClick: (_evt, _elements, chart) => {
          const xScale = chart.scales["x"];
          if (!xScale) return;
          // onTimeChange via canvas click handled via plugin below
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
            ctx.lineTo(xPx, yScale.bottom);
            ctx.strokeStyle = "#f59e0b";
            ctx.lineWidth = 1.5;
            ctx.setLineDash([4, 3]);
            ctx.stroke();
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
      if (xMs !== undefined) {
        onTimeChange(log.startTime + xMs / 1000);
      }
    };
    canvas.addEventListener("click", handleClick);
    return () => canvas.removeEventListener("click", handleClick);
  }, [numericFields, log]);

  // Update cursor without re-building chart
  useEffect(() => {
    chartRef.current?.update("none");
  }, [currentTime]);

  if (numericFields.length === 0 && selectedFields.size > 0) {
    return (
      <div className="chart-empty">
        Selected fields are not numeric. Try selecting Number or Boolean fields to plot.
      </div>
    );
  }

  if (numericFields.length === 0) {
    return (
      <div className="chart-empty">
        Select fields from the sidebar to plot them here.
      </div>
    );
  }

  return (
    <div className="chart-container">
      <canvas ref={canvasRef} />
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
            const displayValue = formatTableValue(value);
            return (
              <tr key={key}>
                <td className="field-key">{key.replace(/^\//, "")}</td>
                <td className="field-type">{field.typeStr}</td>
                <td className="field-value">{displayValue}</td>
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
    return `[${Array.from(value.slice(0, 16))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join(" ")}${value.length > 16 ? "…" : ""}]`;
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
