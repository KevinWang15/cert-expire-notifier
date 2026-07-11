#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const serverDir = path.resolve(__dirname, "..");
const rootEnv = path.resolve(serverDir, "..", ".env");
const target = path.resolve(serverDir, ".env");

if (!fs.existsSync(rootEnv)) {
  console.error("Missing root .env file at " + rootEnv);
  process.exit(1);
}

if (fs.existsSync(target)) {
  fs.unlinkSync(target);
}

const relativeTarget = path.relative(serverDir, rootEnv);
fs.symlinkSync(relativeTarget, target);
console.log("Linked " + target + " -> " + relativeTarget);
