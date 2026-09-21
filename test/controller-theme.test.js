"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");

test("loads local Bootstrap before module and user theme styles", () => {
  const html = fs.readFileSync(path.join(root, "controller", "index.html"), "utf8");
  const bootstrap = html.indexOf("/rehearsal/vendor/bootstrap/bootstrap.min.css");
  const controller = html.indexOf("/rehearsal/assets/controller.css");
  const userTheme = html.indexOf("/rehearsal/theme.css");

  assert.ok(bootstrap >= 0, "Bootstrap stylesheet is missing");
  assert.ok(controller > bootstrap, "controller styles should load after Bootstrap");
  assert.ok(userTheme > controller, "user theme should load last");
  assert.match(html, /data-bs-theme="dark"/);
});

test("pins the supported Bootstrap release and exposes theme tokens", () => {
  const packageJson = require(path.join(root, "package.json"));
  const styles = fs.readFileSync(path.join(root, "controller", "controller.css"), "utf8");

  assert.equal(packageJson.dependencies.bootstrap, "^5.3.8");
  assert.match(styles, /--bs-primary:/);
  assert.match(styles, /--rehearsal-card-bg:/);
});
