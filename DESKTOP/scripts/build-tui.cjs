"use strict";

const fs = require("node:fs");
const path = require("node:path");

const desktopRoot = path.resolve(__dirname, "..");
const sourceRoot = path.resolve(desktopRoot, "..", "TUI");
const targetRoot = path.join(desktopRoot, "dist", "tui");

if (!fs.existsSync(path.join(sourceRoot, "src", "app.js"))) {
  throw new Error(`Newmark TUI source is missing: ${sourceRoot}`);
}

fs.rmSync(targetRoot, { recursive: true, force: true });
fs.mkdirSync(targetRoot, { recursive: true });
for (const entry of ["bin", "src", "package.json"]) {
  fs.cpSync(path.join(sourceRoot, entry), path.join(targetRoot, entry), {
    recursive: true,
    force: true
  });
}

process.stdout.write(`Newmark TUI copied to ${targetRoot}\n`);
