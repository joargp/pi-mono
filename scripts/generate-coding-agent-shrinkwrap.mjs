#!/usr/bin/env node

import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const codingAgentDir = join(repoRoot, "packages/coding-agent");
const lockfilePath = join(repoRoot, "pnpm-lock.yaml");
const workspacePath = join(repoRoot, "pnpm-workspace.yaml");
const shrinkwrapPath = join(codingAgentDir, "npm-shrinkwrap.json");
const internalPackagePrefix = "@earendil-works/pi-";
const trustedRegistryHosts = new Set(["registry.npmjs.org"]);
const installScriptNames = ["preinstall", "install", "postinstall"];
const allowedInstallScriptPackages = new Map([
	["@google/genai@1.52.0", "preinstall is a no-op in the published package"],
	["protobufjs@7.6.5", "postinstall only warns about protobufjs version scheme mismatches"],
]);
const workspaceDirectories = ["ai", "agent", "tui", "coding-agent"];

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

function sortedObject(object) {
	return Object.fromEntries(Object.entries(object).sort(([a], [b]) => a.localeCompare(b)));
}

function sortedPackageEntry(entry) {
	const fieldOrder = [
		"name",
		"version",
		"resolved",
		"integrity",
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
		"optional",
		"hasInstallScript",
		"deprecated",
		"funding",
	];
	const result = {};
	for (const field of fieldOrder) {
		if (entry[field] !== undefined) result[field] = entry[field];
	}
	return result;
}

function packageEntryFromManifest(packageJson, includeName) {
	const entry = includeName ? { name: packageJson.name, version: packageJson.version } : { version: packageJson.version };
	for (const field of [
		"license",
		"peerDependencies",
		"peerDependenciesMeta",
		"bin",
		"engines",
		"os",
		"cpu",
		"libc",
		"deprecated",
		"funding",
	]) {
		if (packageJson[field] !== undefined) entry[field] = packageJson[field];
	}
	return entry;
}

function packageNameFromLockPath(lockPath) {
	const marker = "node_modules/";
	const index = lockPath.lastIndexOf(marker);
	if (index === -1) return undefined;
	const parts = lockPath.slice(index + marker.length).split("/");
	return parts[0]?.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
}

function parseSnapshotKey(snapshotKey) {
	const peerIndex = snapshotKey.indexOf("(");
	const packageId = peerIndex === -1 ? snapshotKey : snapshotKey.slice(0, peerIndex);
	const separator = packageId.lastIndexOf("@");
	if (separator <= 0 || separator === packageId.length - 1) {
		throw new Error(`Unsupported pnpm snapshot key: ${snapshotKey}`);
	}
	return { name: packageId.slice(0, separator), version: packageId.slice(separator + 1) };
}

function registryTarballUrl(packageName, version) {
	const tarballName = packageName.startsWith("@") ? packageName.split("/")[1] : packageName;
	return `https://registry.npmjs.org/${packageName}/-/${tarballName}-${version}.tgz`;
}

function validateRegistryUrl(value, description) {
	let url;
	try {
		url = new URL(value);
	} catch {
		throw new Error(`${description} is not a valid URL: ${value}`);
	}
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		url.port ||
		!trustedRegistryHosts.has(url.hostname)
	) {
		throw new Error(`${description} must use a trusted npm registry host: ${value}`);
	}
}

function resolvedTarballUrl(packageName, version, resolution) {
	if (resolution.tarball !== undefined) {
		validateRegistryUrl(resolution.tarball, `${packageName}@${version} pnpm tarball URL`);
		return resolution.tarball;
	}
	return registryTarballUrl(packageName, version);
}

function dependencyVersion(entry) {
	if (typeof entry === "string") return entry;
	if (entry && typeof entry.version === "string") return entry.version;
	throw new Error(`Unsupported pnpm importer dependency entry: ${JSON.stringify(entry)}`);
}

function normalizeExternalReference(dependencyName, reference, snapshots) {
	const directKey = `${dependencyName}@${reference}`;
	if (snapshots[directKey]) return directKey;

	if (reference.startsWith("npm:")) {
		const alias = reference.slice(4);
		const peerIndex = alias.indexOf("(");
		const packageId = peerIndex === -1 ? alias : alias.slice(0, peerIndex);
		const separator = packageId.lastIndexOf("@");
		if (separator > 0) {
			const aliasedName = packageId.slice(0, separator);
			const aliasedReference = `${packageId.slice(separator + 1)}${peerIndex === -1 ? "" : alias.slice(peerIndex)}`;
			const aliasKey = `${aliasedName}@${aliasedReference}`;
			if (snapshots[aliasKey]) return aliasKey;
		}
	}

	throw new Error(`Cannot resolve ${dependencyName}@${reference} in pnpm-lock.yaml snapshots`);
}

function importerEdges(importer, internalPackages, snapshots) {
	const edges = [];
	for (const [field, optional] of [
		["dependencies", false],
		["optionalDependencies", true],
	]) {
		for (const [name, value] of Object.entries(importer[field] ?? {})) {
			const reference = dependencyVersion(value);
			const nodeKey = internalPackages.has(name)
				? `workspace:${name}`
				: normalizeExternalReference(name, reference, snapshots);
			edges.push({ name, nodeKey, optional });
		}
	}
	return edges.sort((a, b) => a.name.localeCompare(b.name));
}

function snapshotEdges(snapshot, internalPackages, snapshots) {
	const edges = [];
	for (const [field, optional] of [
		["dependencies", false],
		["optionalDependencies", true],
	]) {
		for (const [name, reference] of Object.entries(snapshot[field] ?? {})) {
			if (typeof reference !== "string") {
				throw new Error(`Unsupported ${field} reference for ${name}: ${JSON.stringify(reference)}`);
			}
			const nodeKey = internalPackages.has(name)
				? `workspace:${name}`
				: normalizeExternalReference(name, reference, snapshots);
			edges.push({ name, nodeKey, optional });
		}
	}
	return edges.sort((a, b) => a.name.localeCompare(b.name));
}

function createGraph(lockfile) {
	if (String(lockfile.lockfileVersion) !== "9.0" || !lockfile.importers || !lockfile.packages || !lockfile.snapshots) {
		throw new Error("pnpm-lock.yaml must use lockfileVersion 9.0 and contain importers, packages, and snapshots");
	}

	const internalPackages = new Map();
	for (const directory of workspaceDirectories) {
		const packageJson = readJson(join(repoRoot, "packages", directory, "package.json"));
		if (!packageJson.name?.startsWith(internalPackagePrefix)) {
			throw new Error(`packages/${directory}/package.json is not an internal Pi package`);
		}
		const importer = lockfile.importers[`packages/${directory}`];
		if (!importer) throw new Error(`pnpm-lock.yaml is missing the packages/${directory} importer`);
		internalPackages.set(packageJson.name, { directory, importer, packageJson });
	}

	const nodes = new Map();
	for (const [name, workspace] of internalPackages) {
		nodes.set(`workspace:${name}`, {
			kind: "workspace",
			name,
			version: workspace.packageJson.version,
			packageJson: workspace.packageJson,
			packageDirectory: join(repoRoot, "packages", workspace.directory),
			edges: importerEdges(workspace.importer, internalPackages, lockfile.snapshots),
		});
	}

	function getNode(nodeKey) {
		const existing = nodes.get(nodeKey);
		if (existing) return existing;
		const snapshot = lockfile.snapshots[nodeKey];
		if (!snapshot) throw new Error(`pnpm-lock.yaml is missing snapshot ${nodeKey}`);
		const { name, version } = parseSnapshotKey(nodeKey);
		const packageMetadata = lockfile.packages[`${name}@${version}`];
		if (!packageMetadata?.resolution?.integrity) {
			throw new Error(`${name}@${version} is missing resolution integrity metadata in pnpm-lock.yaml`);
		}
		const node = {
			kind: "external",
			name,
			version,
			resolved: resolvedTarballUrl(name, version, packageMetadata.resolution),
			packageMetadata,
			edges: snapshotEdges(snapshot, internalPackages, lockfile.snapshots),
		};
		nodes.set(nodeKey, node);
		return node;
	}

	const rootWorkspace = internalPackages.get("@earendil-works/pi-coding-agent");
	if (!rootWorkspace) throw new Error("Cannot find the coding-agent workspace package");
	const rootEdges = importerEdges(rootWorkspace.importer, internalPackages, lockfile.snapshots);
	const reachable = new Set();
	const queue = [...rootEdges.map((edge) => edge.nodeKey)];
	while (queue.length > 0) {
		const nodeKey = queue.shift();
		if (reachable.has(nodeKey)) continue;
		reachable.add(nodeKey);
		for (const edge of getNode(nodeKey).edges) queue.push(edge.nodeKey);
	}

	return { getNode, reachable, rootEdges, rootWorkspace };
}

function supportedArchitectures(graph) {
	const values = { cpu: new Set(), libc: new Set(), os: new Set() };
	for (const nodeKey of graph.reachable) {
		const node = graph.getNode(nodeKey);
		if (node.kind !== "external") continue;
		for (const field of ["os", "cpu", "libc"]) {
			for (const value of node.packageMetadata[field] ?? []) {
				if (typeof value === "string" && !value.startsWith("!")) values[field].add(value);
			}
		}
	}
	return values;
}

function writeTemporaryWorkspace(tempDirectory, architectures) {
	cpSync(join(repoRoot, "package.json"), join(tempDirectory, "package.json"));
	cpSync(lockfilePath, join(tempDirectory, "pnpm-lock.yaml"));
	for (const directory of workspaceDirectories) {
		const targetDirectory = join(tempDirectory, "packages", directory);
		mkdirSync(targetDirectory, { recursive: true });
		cpSync(join(repoRoot, "packages", directory, "package.json"), join(targetDirectory, "package.json"));
	}

	const formatValues = (values) => JSON.stringify([...values].sort());
	const workspace = `${readFileSync(workspacePath, "utf8").trimEnd()}\n` +
		"supportedArchitectures:\n" +
		`  os: ${formatValues(architectures.os)}\n` +
		`  cpu: ${formatValues(architectures.cpu)}\n` +
		`  libc: ${formatValues(architectures.libc)}\n`;
	writeFileSync(join(tempDirectory, "pnpm-workspace.yaml"), workspace);
}

function runPnpmInstall(tempDirectory) {
	const result = spawnSync(
		"pnpm",
		[
			"install",
			"--filter",
			"@earendil-works/pi-coding-agent",
			"--prod",
			"--frozen-lockfile",
			"--ignore-scripts",
		],
		{ cwd: tempDirectory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
	);
	if (result.status !== 0) {
		throw new Error(`Isolated pnpm install failed:\n${result.stdout}${result.stderr}`);
	}
}

function installedPackageManifests(tempDirectory) {
	const virtualStoreDirectory = join(tempDirectory, "node_modules/.pnpm");
	if (!existsSync(virtualStoreDirectory)) throw new Error("Isolated pnpm install did not create a virtual store");
	const manifests = new Map();

	function addManifest(packageDirectory) {
		const packageJsonPath = join(packageDirectory, "package.json");
		if (!existsSync(packageJsonPath) || !statSync(packageJsonPath).isFile()) return;
		const packageJson = readJson(packageJsonPath);
		if (!packageJson.name || !packageJson.version) return;
		const packageId = `${packageJson.name}@${packageJson.version}`;
		const current = manifests.get(packageId);
		if (current && readFileSync(current.path, "utf8") !== readFileSync(packageJsonPath, "utf8")) {
			throw new Error(`Isolated install contains inconsistent manifests for ${packageId}`);
		}
		manifests.set(packageId, { packageJson, path: realpathSync(packageJsonPath) });
	}

	for (const virtualEntry of readdirSync(virtualStoreDirectory, { withFileTypes: true })) {
		if (!virtualEntry.isDirectory()) continue;
		const nodeModulesDirectory = join(virtualStoreDirectory, virtualEntry.name, "node_modules");
		if (!existsSync(nodeModulesDirectory)) continue;
		for (const entry of readdirSync(nodeModulesDirectory, { withFileTypes: true })) {
			const entryPath = join(nodeModulesDirectory, entry.name);
			if (entry.name.startsWith("@") && entry.isDirectory()) {
				for (const scopedEntry of readdirSync(entryPath, { withFileTypes: true })) {
					if (scopedEntry.isDirectory() || scopedEntry.isSymbolicLink()) addManifest(join(entryPath, scopedEntry.name));
				}
			} else if (entry.isDirectory() || entry.isSymbolicLink()) {
				addManifest(entryPath);
			}
		}
	}
	return manifests;
}

function inspectPackageManifests(graph) {
	const tempDirectory = mkdtempSync(join(tmpdir(), "pi-shrinkwrap-"));
	try {
		writeTemporaryWorkspace(tempDirectory, supportedArchitectures(graph));
		runPnpmInstall(tempDirectory);
		const manifests = installedPackageManifests(tempDirectory);
		const requiredManifests = new Map();
		for (const nodeKey of graph.reachable) {
			const node = graph.getNode(nodeKey);
			if (node.kind !== "external") continue;
			const packageId = `${node.name}@${node.version}`;
			const manifest = manifests.get(packageId);
			if (!manifest) {
				throw new Error(`Isolated pnpm install did not materialize locked package ${packageId}`);
			}
			requiredManifests.set(packageId, manifest);
		}
		return requiredManifests;
	} finally {
		rmSync(tempDirectory, { force: true, recursive: true });
	}
}

function dependencyCandidatePaths(fromPath, dependencyName) {
	const candidates = [];
	let current = fromPath;
	while (current) {
		candidates.push(`${current}/node_modules/${dependencyName}`);
		const marker = current.lastIndexOf("/node_modules/");
		current = marker === -1 ? "" : current.slice(0, marker);
	}
	candidates.push(`node_modules/${dependencyName}`);
	return candidates;
}

function layoutGraph(graph) {
	const placements = new Map();
	const queue = graph.rootEdges.map((edge) => ({ edge, fromPath: "", parentOptional: false }));

	while (queue.length > 0) {
		const { edge, fromPath, parentOptional } = queue.shift();
		const optional = parentOptional || edge.optional;
		const candidates = dependencyCandidatePaths(fromPath, edge.name);
		let targetPath = candidates.find((candidate) => placements.get(candidate)?.nodeKey === edge.nodeKey);
		let isNew = false;

		if (!targetPath) {
			const rootPath = `node_modules/${edge.name}`;
			if (!placements.has(rootPath)) {
				targetPath = rootPath;
			} else {
				targetPath = `${fromPath}/node_modules/${edge.name}`;
				if (!fromPath || (placements.has(targetPath) && placements.get(targetPath).nodeKey !== edge.nodeKey)) {
					throw new Error(`Cannot place ${edge.nodeKey} for ${fromPath || "root"}`);
				}
			}
			placements.set(targetPath, { name: edge.name, nodeKey: edge.nodeKey, optional });
			isNew = true;
		}

		const placement = placements.get(targetPath);
		const becameRequired = placement.optional && !optional;
		if (becameRequired) placement.optional = false;
		if (isNew || becameRequired) {
			for (const childEdge of graph.getNode(edge.nodeKey).edges) {
				queue.push({ edge: childEdge, fromPath: targetPath, parentOptional: placement.optional });
			}
		}
	}
	return placements;
}

function packageDependenciesForNode(node, graph) {
	const dependencies = {};
	const optionalDependencies = {};
	for (const edge of node.edges) {
		const dependencyNode = graph.getNode(edge.nodeKey);
		const version =
			dependencyNode.name === edge.name
				? dependencyNode.version
				: `npm:${dependencyNode.name}@${dependencyNode.version}`;
		(edge.optional ? optionalDependencies : dependencies)[edge.name] = version;
	}
	return {
		dependencies: Object.keys(dependencies).length > 0 ? sortedObject(dependencies) : undefined,
		optionalDependencies: Object.keys(optionalDependencies).length > 0 ? sortedObject(optionalDependencies) : undefined,
	};
}

function hasInstallScript(packageJson, packageDirectory) {
	return (
		installScriptNames.some((name) => typeof packageJson.scripts?.[name] === "string") ||
		existsSync(join(packageDirectory, "binding.gyp"))
	);
}

function createPackageEntry(node, installedName, optional, graph, manifests) {
	if (node.kind === "workspace") {
		const entry = packageEntryFromManifest(node.packageJson, false);
		if (installedName !== node.name) entry.name = node.name;
		entry.resolved = registryTarballUrl(node.name, node.version);
		const dependencies = packageDependenciesForNode(node, graph);
		if (dependencies.dependencies) entry.dependencies = dependencies.dependencies;
		if (dependencies.optionalDependencies) entry.optionalDependencies = dependencies.optionalDependencies;
		if (optional) entry.optional = true;
		if (hasInstallScript(node.packageJson, node.packageDirectory)) entry.hasInstallScript = true;
		return sortedPackageEntry(entry);
	}

	const packageId = `${node.name}@${node.version}`;
	const manifest = manifests.get(packageId);
	if (!manifest) throw new Error(`Missing inspected manifest for ${packageId}`);
	const packageJson = manifest.packageJson;
	const entry = packageEntryFromManifest(packageJson, false);
	if (installedName !== node.name) entry.name = node.name;
	entry.resolved = node.resolved;
	entry.integrity = node.packageMetadata.resolution.integrity;
	const dependencies = packageDependenciesForNode(node, graph);
	if (dependencies.dependencies) entry.dependencies = dependencies.dependencies;
	if (dependencies.optionalDependencies) entry.optionalDependencies = dependencies.optionalDependencies;
	if (optional) entry.optional = true;
	if (hasInstallScript(packageJson, dirname(manifest.path))) entry.hasInstallScript = true;
	return sortedPackageEntry(entry);
}

function findDependency(packages, fromPath, dependencyName) {
	return dependencyCandidatePaths(fromPath, dependencyName).find((candidate) => packages[candidate]);
}

function validateShrinkwrap(shrinkwrap) {
	const errors = [];
	const packages = shrinkwrap.packages ?? {};
	const seenAllowedInstallScriptPackages = new Set();
	if (shrinkwrap.lockfileVersion !== 3 || !packages[""]) {
		errors.push("shrinkwrap must use lockfileVersion 3 and contain a root package entry");
	}

	for (const [lockPath, entry] of Object.entries(packages)) {
		const packageName = entry.name ?? packageNameFromLockPath(lockPath);
		if (entry.link) errors.push(`${lockPath} is a link entry`);
		if (lockPath && (!entry.version || !entry.resolved || !entry.integrity)) {
			if (!packageName?.startsWith(internalPackagePrefix) || !entry.version || !entry.resolved) {
				errors.push(`${lockPath} is missing version, resolved, or integrity metadata`);
			}
		}
		if (typeof entry.resolved === "string") {
			try {
				validateRegistryUrl(entry.resolved, `${lockPath} resolved URL`);
			} catch (error) {
				errors.push(error instanceof Error ? error.message : String(error));
			}
		}
		if (entry.hasInstallScript) {
			const packageId = packageName && entry.version ? `${packageName}@${entry.version}` : undefined;
			if (packageId && allowedInstallScriptPackages.has(packageId)) {
				seenAllowedInstallScriptPackages.add(packageId);
			} else {
				errors.push(`${lockPath || "root"} has unreviewed install scripts (${packageId ?? "unknown package"})`);
			}
		}
		for (const [dependencyName, dependencyVersion] of Object.entries({
			...(entry.dependencies ?? {}),
			...(entry.optionalDependencies ?? {}),
		})) {
			const dependencyPath = findDependency(packages, lockPath, dependencyName);
			if (!dependencyPath) {
				errors.push(`${lockPath || "root"} dependency ${dependencyName} cannot be resolved from the shrinkwrap`);
			} else {
				const exactVersion =
					typeof dependencyVersion === "string"
						? dependencyVersion.match(/^=?((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?)$/)?.[1]
						: undefined;
				if (exactVersion && packages[dependencyPath].version !== exactVersion) {
					errors.push(
					`${lockPath || "root"} dependency ${dependencyName}@${dependencyVersion} resolves to ${packages[dependencyPath].version}`,
				);
				}
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
	if (errors.length > 0) {
		throw new Error(`Generated shrinkwrap failed validation:\n${errors.map((error) => `  - ${error}`).join("\n")}`);
	}
}

function generateShrinkwrap() {
	const requireFromCodingAgent = createRequire(join(codingAgentDir, "package.json"));
	const { parse } = requireFromCodingAgent("yaml");
	const lockfile = parse(readFileSync(lockfilePath, "utf8"));
	const graph = createGraph(lockfile);
	const manifests = inspectPackageManifests(graph);
	const placements = layoutGraph(graph);
	const rootPackageJson = graph.rootWorkspace.packageJson;
	const rootEntry = packageEntryFromManifest(rootPackageJson, true);
	rootEntry.dependencies = rootPackageJson.dependencies;
	rootEntry.optionalDependencies = rootPackageJson.optionalDependencies;

	const packages = { "": sortedPackageEntry(rootEntry) };
	for (const [lockPath, placement] of [...placements].sort(([a], [b]) => a.localeCompare(b))) {
		packages[lockPath] = createPackageEntry(
			graph.getNode(placement.nodeKey),
			placement.name,
			placement.optional,
			graph,
			manifests,
		);
	}
	const shrinkwrap = {
		name: rootPackageJson.name,
		version: rootPackageJson.version,
		lockfileVersion: 3,
		requires: true,
		packages,
	};
	validateShrinkwrap(shrinkwrap);
	return shrinkwrap;
}

try {
	const shrinkwrap = generateShrinkwrap();
	const content = `${JSON.stringify(shrinkwrap, null, "\t")}\n`;
	if (checkOnly) {
		if (!existsSync(shrinkwrapPath) || readFileSync(shrinkwrapPath, "utf8") !== content) {
			console.error("packages/coding-agent/npm-shrinkwrap.json is out of date.");
			console.error("Run: pnpm run shrinkwrap:coding-agent");
			process.exit(1);
		}
		console.log("packages/coding-agent/npm-shrinkwrap.json is valid and synchronized with pnpm-lock.yaml.");
	} else {
		writeFileSync(shrinkwrapPath, content);
		const packageCount = Object.keys(shrinkwrap.packages).length - 1;
		const platformCount = Object.values(shrinkwrap.packages).filter((entry) => entry.os || entry.cpu || entry.libc).length;
		console.log(`Updated packages/coding-agent/npm-shrinkwrap.json (${packageCount} packages, ${platformCount} platform-specific).`);
	}
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
