/** `83` → `1:23`, `3723` → `1:02:03`. */
export function duration(seconds: number): string {
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

export function fileSize(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** `source_work` → `Source work`. */
export const fieldLabel = (field: string) =>
  field.charAt(0).toUpperCase() + field.slice(1).replaceAll("_", " ");

/** Writes a value so the query language reads it back as one literal value. */
export function quoteValue(value: string): string {
  const escaped = value.replace(/[\\*]/g, "\\$&").replace(/"/g, '\\"');
  return /[\s(),"]/.test(value) || /^-|^or$/i.test(value) || escaped !== value
    ? `"${escaped}"`
    : value;
}
