export function mountAmbient(
  document,
  { count = 28, host = document.body } = {},
) {
  if (
    !host ||
    [...host.children].some((child) => child.classList.contains("ambient-snow"))
  )
    return () => {};
  const layer = document.createElement("div");
  layer.className = "ambient-snow";
  layer.setAttribute("aria-hidden", "true");
  for (let i = 0; i < Math.min(32, Math.max(0, count)); i++) {
    const flake = document.createElement("span");
    flake.style.setProperty("--snow-x", `${(i * 37 + 9) % 100}%`);
    flake.style.setProperty("--snow-size", `${14 + (i % 5) * 3}px`);
    flake.style.setProperty("--snow-opacity", String(0.45 + (i % 4) * 0.08));
    flake.style.setProperty("--snow-angle", `${i * 23}deg`);
    flake.style.setProperty("--snow-spin", `${i % 2 ? -140 : 140}deg`);
    flake.style.setProperty(
      "--snow-drift",
      `${(i % 2 ? -1 : 1) * (24 + (i % 33))}px`,
    );
    flake.style.setProperty("--snow-speed", `${12 + (i % 12)}s`);
    flake.style.setProperty("--snow-delay", `${-((i * 7) % 31)}s`);
    const namespace = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(namespace, "svg");
    svg.setAttribute("viewBox", "-12 -12 24 24");
    svg.setAttribute("focusable", "false");
    for (let angle = 0; angle < 360; angle += 60) {
      const arm = document.createElementNS(namespace, "path");
      arm.setAttribute("d", "M0 0V-10M0-6L-3-9M0-6L3-9");
      arm.setAttribute("transform", `rotate(${angle})`);
      svg.append(arm);
    }
    flake.append(svg);
    layer.append(flake);
  }
  host.prepend(layer);
  const visibility = () => {
    layer.dataset.paused = String(document.hidden);
  };
  visibility();
  document.addEventListener("visibilitychange", visibility);
  return () => {
    document.removeEventListener("visibilitychange", visibility);
    layer.remove();
  };
}
if (typeof document !== "undefined")
  mountAmbient(document, {
    count:
      typeof navigator !== "undefined" && navigator.hardwareConcurrency <= 2
        ? 14
        : 28,
  });
