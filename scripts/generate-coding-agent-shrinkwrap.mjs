#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const codingAgentDir = join(repoRoot, "packages/coding-agent");
const shrinkwrapPath = join(codingAgentDir, "npm-shrinkwrap.json");
const internalPackagePrefix = "@earendil-works/pi-";
const allowedInstallScriptPackages = new Map([
	["@google/genai@1.52.0", "preinstall is a no-op in the published package"],
	["protobufjs@7.5.9", "postinstall only warns about protobufjs version scheme mismatches"],
]);

const args = new Set(process.argv.slice(2));
const checkOnly = args.has("--check");
for (const arg of args) {
	if (arg !== "--check") {
		console.error(`Unknown argument: ${arg}`);
		process.exit(1);
	}
}

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function packageDependencies(entry) {
	return { ...(entry.dependencies ?? {}), ...(entry.optionalDependencies ?? {}) };
}

function sortedObject(object) {
	return Object.fromEntries(Object.entries(object).sort(([a], [b]) => a.localeCompare(b)));
}

function packageNameFromLockPath(lockPath) {
	const marker = "node_modules/";
	const index = lockPath.lastIndexOf(marker);
	if (index === -1) return undefined;
	const parts = lockPath.slice(index + marker.length).split("/");
	return parts[0]?.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
}

function registryTarballUrl(packageName, version) {
	const tarballName = packageName.startsWith("@") ? packageName.split("/")[1] : packageName;
	return `https://registry.npmjs.org/${packageName}/-/${tarballName}-${version}.tgz`;
}

function manifestEntry(packageJson, includeName) {
	const entry = includeName ? { name: packageJson.name, version: packageJson.version } : { version: packageJson.version };
	for (const field of [
		"license",
		"dependencies",
		"optionalDependencies",
		"peerDependencies",
		"peerDependenciesMeta",
		"bin",
		"engines",
		"os",
		"cpu",
		"libc",
	]) {
		if (packageJson[field] !== undefined) entry[field] = packageJson[field];
	}
	return entry;
}

function findDependency(packages, fromPath, dependencyName) {
	let current = fromPath;
	while (current) {
		const nested = `${current}/node_modules/${dependencyName}`;
		if (packages[nested]) return nested;
		const marker = current.lastIndexOf("/node_modules/");
		current = marker === -1 ? "" : current.slice(0, marker);
	}
	const rootPath = `node_modules/${dependencyName}`;
	return packages[rootPath] ? rootPath : undefined;
}

function synchronizeWorkspaceEntries(shrinkwrap) {
	const codingAgentPackage = readJson(join(codingAgentDir, "package.json"));
	shrinkwrap.name = codingAgentPackage.name;
	shrinkwrap.version = codingAgentPackage.version;
	shrinkwrap.lockfileVersion = 3;
	shrinkwrap.requires = true;
	shrinkwrap.packages[""] = manifestEntry(codingAgentPackage, true);

	for (const workspaceDir of ["ai", "agent", "tui"]) {
		const packageJson = readJson(join(repoRoot, "packages", workspaceDir, "package.json"));
		const lockPath = `node_modules/${packageJson.name}`;
		if (!shrinkwrap.packages[lockPath]) continue;
		const { version, ...metadata } = manifestEntry(packageJson, false);
		shrinkwrap.packages[lockPath] = {
			version,
			resolved: registryTarballUrl(packageJson.name, packageJson.version),
			...metadata,
		};
	}

	shrinkwrap.packages = sortedObject(shrinkwrap.packages);
	return shrinkwrap;
}

function validateShrinkwrap(shrinkwrap) {
	const errors = [];
	const packages = shrinkwrap.packages ?? {};
	const seenAllowedInstallScriptPackages = new Set();

	if (shrinkwrap.lockfileVersion !== 3 || !packages[""]) {
		errors.push("shrinkwrap must use lockfileVersion 3 and contain a root package entry");
	}

	for (const [lockPath, entry] of Object.entries(packages)) {
		const packageName = packageNameFromLockPath(lockPath);
		if (entry.link) errors.push(`${lockPath} is a link entry`);
		if (lockPath && (!entry.version || !entry.resolved || !entry.integrity)) {
			if (!packageName?.startsWith(internalPackagePrefix) || !entry.version || !entry.resolved) {
				errors.push(`${lockPath} is missing version, resolved, or integrity metadata`);
			}
		}
		if (typeof entry.resolved === "string" && /^(file:|link:|workspace:|\.\.?\/|\/)/.test(entry.resolved)) {
			errors.push(`${lockPath} has a local resolved value: ${entry.resolved}`);
		}
		if (entry.hasInstallScript) {
			const packageId = packageName && entry.version ? `${packageName}@${entry.version}` : undefined;
			if (packageId && allowedInstallScriptPackages.has(packageId)) {
				seenAllowedInstallScriptPackages.add(packageId);
			} else {
				errors.push(`${lockPath || "root"} has unreviewed install scripts (${packageId ?? "unknown package"})`);
			}
		}
		for (const [dependencyName, dependencySpec] of Object.entries(packageDependencies(entry))) {
			const dependencyPath = findDependency(packages, lockPath, dependencyName);
			if (!dependencyPath) {
				errors.push(`${lockPath || "root"} dependency ${dependencyName} cannot be resolved from the shrinkwrap`);
				continue;
			}
			const exactVersion = typeof dependencySpec === "string" ? dependencySpec.match(/^=?((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?)$/)?.[1] : undefined;
			if (exactVersion && packages[dependencyPath].version !== exactVersion) {
				errors.push(
					`${lockPath || "root"} dependency ${dependencyName}@${dependencySpec} resolves to ${packages[dependencyPath].version}`,
				);
			}
		}
	}

	for (const packageId of allowedInstallScriptPackages.keys()) {
		if (!seenAllowedInstallScriptPackages.has(packageId)) {
			errors.push(`allowed install-script package ${packageId} is no longer present; remove it from the allowlist`);
		}
	}
	if (!Object.values(packages).some((entry) => entry.os || entry.cpu || entry.libc)) {
		errors.push("no platform-specific optional dependency entries found");
	}
	if (errors.length) throw new Error(`Generated shrinkwrap failed validation:\n${errors.map((error) => `  - ${error}`).join("\n")}`);
}

try {
	if (!existsSync(shrinkwrapPath)) throw new Error("packages/coding-agent/npm-shrinkwrap.json is missing");
	const current = readFileSync(shrinkwrapPath, "utf8");
	const shrinkwrap = synchronizeWorkspaceEntries(JSON.parse(current));
	validateShrinkwrap(shrinkwrap);
	const content = `${JSON.stringify(shrinkwrap, null, "\t")}\n`;

	if (checkOnly) {
		if (current !== content) {
			console.error("packages/coding-agent/npm-shrinkwrap.json is out of date.");
			console.error("Run: pnpm run shrinkwrap:coding-agent");
			process.exit(1);
		}
		console.log("packages/coding-agent/npm-shrinkwrap.json is valid and up to date.");
	} else {
		writeFileSync(shrinkwrapPath, content);
		console.log(`Updated packages/coding-agent/npm-shrinkwrap.json (${Object.keys(shrinkwrap.packages).length - 1} packages).`);
	}
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
