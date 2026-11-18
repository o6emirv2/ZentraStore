"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, ".."),
  files = [],
  failures = [];
function walk(dir) {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    if (
      [
        "node_modules",
        ".git",
        "dist-pages",
        "test-results",
        "coverage",
      ].includes(item.name)
    )
      continue;
    const p = path.join(dir, item.name);
    if (item.isDirectory()) walk(p);
    else files.push(p);
  }
}
walk(root);
let scripts = 0,
  references = 0;
for (const file of files) {
  const name = path.relative(root, file).replaceAll(path.sep, "/");
  if (!/\.(js|mjs|cjs|json|html|css)$/.test(name)) continue;
  const source = fs.readFileSync(file, "utf8");
  if (/\.(js|mjs|cjs)$/.test(name)) {
    const esm =
      name === "script.js" ||
      name.startsWith("admin/") ||
      name.startsWith("public/js/") ||
      name.endsWith(".mjs");
    const r = spawnSync(
      process.execPath,
      esm ? ["--input-type=module", "--check"] : ["--check", file],
      { input: esm ? source : undefined, encoding: "utf8" },
    );
    if (r.status !== 0) failures.push(name + ": " + r.stderr);
    scripts++;
  }
  if (name.endsWith(".json"))
    try {
      JSON.parse(source);
    } catch {
      failures.push(name + ": invalid JSON");
    }
  if (name.endsWith(".html")) {
    const viewports = [
      ...source.matchAll(/<meta\b[^>]*name=["']viewport["'][^>]*>/gi),
    ];
    if (
      viewports.length !== 1 ||
      !/content="width=device-width, initial-scale=1, viewport-fit=cover"/.test(viewports[0][0])
    )
      failures.push(
        name + ": viewport differs from the requested device policy",
      );
    const ids = [...source.matchAll(/\sid="([^"]+)"/g)].map((x) => x[1]);
    if (ids.length !== new Set(ids).size)
      failures.push(name + ": duplicate element ID");
    if (name === "index.html") {
      for (const required of ["catalog", "productSearch", "authSheet", "customerApp"])
        if (!ids.includes(required)) failures.push(name + ": missing " + required);
    }
    if (name === "store-pages.html")
      for (const required of [
        "main",
        "search-form",
        "search-input",
        "search-suggestions",
        "cart-count",
        "mobile-cart-count",
        "footer-social",
        "toasts",
      ]) {
        if (!ids.includes(required))
          failures.push(name + ": missing required element " + required);
      }
    for (const m of source.matchAll(/\b(?:src|href)="([^"]+)"/g)) {
      const ref = m[1].split(/[?#]/)[0];
      if (
        /^(?:https?:|data:|mailto:|tel:|#|\/\/)/.test(ref) ||
        !/\.(?:js|mjs|css|png|jpg|jpeg|webp|ico|svg|webmanifest)$/.test(ref)
      )
        continue;
      const aliases = {
        "/favicon.ico": "public/assets/images/favicon.ico",
        "/apple-touch-icon.png": "public/assets/images/apple-touch-icon.png",
      };
      const dest = aliases[ref]
        ? path.join(root, aliases[ref])
        : ref.startsWith("/")
          ? path.join(root, ref)
          : path.resolve(path.dirname(file), ref);
      references++;
      if (!fs.existsSync(dest)) failures.push(name + ": missing " + ref);
    }
  }
  if (name.endsWith(".css")) {
    const cleaned = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, "");
    if (
      (cleaned.match(/{/g) || []).length !== (cleaned.match(/}/g) || []).length
    )
      failures.push(name + ": CSS block imbalance");
    for (const m of source.matchAll(/url\(['"]?([^)'"\s]+)['"]?\)/g)) {
      const ref = m[1].split(/[?#]/)[0];
      if (/^(https?:|data:|#)/.test(ref)) continue;
      references++;
      if (
        !fs.existsSync(
          ref.startsWith("/")
            ? path.join(root, ref)
            : path.resolve(path.dirname(file), ref),
        )
      )
        failures.push(name + ": missing CSS asset " + ref);
    }
  }
}
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"))),
  lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json")));
if (
  pkg.version !== lock.version ||
  pkg.version !== lock.packages[""].version ||
  JSON.stringify(pkg.dependencies) !==
    JSON.stringify(lock.packages[""].dependencies)
)
  failures.push("Package/lock mismatch");
if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else
  console.log(
    JSON.stringify({
      scripts,
      localReferences: references,
      html: files.filter((x) => x.endsWith(".html")).length,
      result: "PASS",
    }),
  );
