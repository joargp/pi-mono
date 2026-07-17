#!/usr/bin/env node

import { execFileSync } from "node:child_process";

const stagedChanges = execFileSync("git", ["diff", "--cached", "--name-status"], { encoding: "utf8" })
	.split("\n")
	.map((line) => line.trim())
	.filter(Boolean);
const staged = stagedChanges.map((line) => line.split("\t").at(-1));

if (!staged.includes("pnpm-lock.yaml")) process.exit(0);
if (stagedChanges.includes("A\tpnpm-lock.yaml") && stagedChanges.includes("D\tpackage-lock.json")) {
	console.error("package-lock.json is being replaced by pnpm-lock.yaml; allowing the package-manager migration.");
	process.exit(0);
}
if (["1", "true", "yes"].includes(process.env.PI_ALLOW_LOCKFILE_CHANGE ?? "")) {
	console.error("pnpm-lock.yaml is staged; PI_ALLOW_LOCKFILE_CHANGE is set, allowing commit.");
	process.exit(0);
}
console.error("pnpm-lock.yaml is staged. Review dependency and lifecycle-script changes before committing.");
console.error("If intentional, commit with PI_ALLOW_LOCKFILE_CHANGE=1.");
process.exit(1);
