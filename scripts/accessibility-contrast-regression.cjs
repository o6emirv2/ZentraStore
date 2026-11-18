"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const css = fs.readFileSync(
  require.resolve("../public/css/design-tokens.css"),
  "utf8",
);
const tokens = Object.fromEntries(
  [...css.matchAll(/--([a-z-]+):\s*(#[a-f0-9]{3}(?:[a-f0-9]{3})?);/g)].map(
    (x) => [x[1], x[2]],
  ),
);
function luminance(hex) {
  if (hex.length === 4)
    hex = "#" + [...hex.slice(1)].map((x) => x + x).join("");
  const rgb = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return rgb.reduce((s, c, i) => s + c * [0.2126, 0.7152, 0.0722][i], 0);
}
test("semantic text and primary actions meet WCAG AA normal-text contrast", () => {
  for (const [foreground, background] of [
    ["ink", "surface"],
    ["ink", "paper"],
    ["muted", "surface"],
    ["muted", "paper"],
    ["white", "action"],
    ["accent-dark", "surface"],
    ["accent", "tint"],
    ["white", "green"],
  ]) {
    assert(tokens[foreground] && tokens[background]);
    const values = [
      luminance(tokens[foreground]),
      luminance(tokens[background]),
    ].sort((a, b) => b - a);
    const ratio = (values[0] + 0.05) / (values[1] + 0.05);
    assert(
      ratio >= 4.5,
      `${foreground} / ${background}: ${ratio.toFixed(2)}:1`,
    );
  }
});
