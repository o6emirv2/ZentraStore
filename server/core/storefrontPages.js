"use strict";
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "../..");
const missing = fs
  .readFileSync(path.join(root, "404.html"), "utf8")
  .replace('data-recovery="missing"', 'data-recovery="final"');
const unavailable = fs.readFileSync(
  path.join(root, "unavailable.html"),
  "utf8",
);
function send(res, source, status) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.setHeader("Referrer-Policy", "no-referrer");
  return res.status(status).type("html").send(source);
}
const sendMissing = (res) => send(res, missing, 404);
const sendUnavailable = (res, status = 503) => send(res, unavailable, status);
module.exports = { sendMissing, sendUnavailable };
