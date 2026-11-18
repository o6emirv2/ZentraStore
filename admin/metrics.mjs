export function metricValue(metrics, key) {
  const value = metrics?.[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}
export function metricLabel(metrics, key, format = String) {
  const value = metricValue(metrics, key);
  return value === null ? "Doğrulanamadı" : format(value);
}
