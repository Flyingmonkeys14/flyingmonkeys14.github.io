import type { ParsedLog } from "../types";

interface StatsTableProps {
  log: ParsedLog;
  selectedFields: Set<string>;
}

interface FieldStats {
  key: string;
  count: number;
  min: number;
  max: number;
  range: number;
  mean: number;
  median: number;
  stdDev: number;
  variance: number;
  geometricMean: number | null;
  p25: number;
  p75: number;
  sum: number;
  rms: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function computeStats(values: number[]): Omit<FieldStats, "key"> | null {
  if (values.length === 0) return null;

  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const sum = values.reduce((s, v) => s + v, 0);
  const mean = sum / n;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
  const stdDev = Math.sqrt(variance);

  let geometricMean: number | null = null;
  if (values.every((v) => v > 0)) {
    const logSum = values.reduce((s, v) => s + Math.log(v), 0);
    geometricMean = Math.exp(logSum / n);
  }

  const rms = Math.sqrt(values.reduce((s, v) => s + v * v, 0) / n);

  return {
    count: n,
    min: sorted[0],
    max: sorted[n - 1],
    range: sorted[n - 1] - sorted[0],
    mean,
    median: percentile(sorted, 50),
    stdDev,
    variance,
    geometricMean,
    p25: percentile(sorted, 25),
    p75: percentile(sorted, 75),
    sum,
    rms,
  };
}

function fmt(v: number | null, digits = 6): string {
  if (v === null || !isFinite(v as number)) return "—";
  const n = v as number;
  if (Number.isInteger(n) && Math.abs(n) < 1e9) return n.toString();
  return parseFloat(n.toPrecision(digits)).toString();
}

export function StatsTable({ log, selectedFields }: StatsTableProps) {
  if (selectedFields.size === 0) {
    return (
      <div className="stats-empty">
        Select numeric fields from the sidebar to view statistics.
      </div>
    );
  }

  const rows: FieldStats[] = [];
  for (const key of selectedFields) {
    const field = log.fields[key];
    if (!field || (field.type !== "Number" && field.type !== "Boolean")) continue;
    const values = field.entries
      .map((e) => (typeof e.value === "boolean" ? (e.value ? 1 : 0) : (e.value as number)))
      .filter((v) => isFinite(v));
    const stats = computeStats(values);
    if (stats) rows.push({ key, ...stats });
  }

  if (rows.length === 0) {
    return (
      <div className="stats-empty">
        No numeric fields selected. Stats are available for Number and Boolean fields.
      </div>
    );
  }

  const statDefs: { label: string; key: keyof Omit<FieldStats, "key">; title?: string }[] = [
    { label: "Count", key: "count" },
    { label: "Min", key: "min" },
    { label: "Max", key: "max" },
    { label: "Range", key: "range" },
    { label: "Sum", key: "sum" },
    { label: "Mean", key: "mean", title: "Arithmetic mean (average)" },
    { label: "Median", key: "median", title: "50th percentile" },
    { label: "Std Dev", key: "stdDev", title: "Population standard deviation" },
    { label: "Variance", key: "variance", title: "Population variance" },
    { label: "Geo Mean", key: "geometricMean", title: "Geometric mean (only for all-positive values)" },
    { label: "RMS", key: "rms", title: "Root mean square" },
    { label: "P25", key: "p25", title: "25th percentile" },
    { label: "P75", key: "p75", title: "75th percentile" },
  ];

  return (
    <div className="stats-table-wrap">
      <table className="stats-table">
        <thead>
          <tr>
            <th className="stats-stat-col">Statistic</th>
            {rows.map((r) => (
              <th key={r.key} className="stats-field-col" title={r.key}>
                {r.key.replace(/^\//, "").split("/").pop()}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {statDefs.map(({ label, key, title }) => (
            <tr key={key}>
              <td className="stats-label" title={title}>{label}</td>
              {rows.map((r) => {
                const val = r[key];
                return (
                  <td key={r.key} className="stats-value">
                    {key === "count"
                      ? String(val)
                      : fmt(val as number | null)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
