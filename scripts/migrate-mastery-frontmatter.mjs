import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { migrateMasteryFrontmatter } from "../lib/teach-learning-state.ts";

const SKIPPED_DIRECTORY_NAMES = new Set([".obsidian", ".git", ".pi", "node_modules", ".trash"]);

export function collectMarkdownFiles(targetPath) {
	const resolvedTarget = path.resolve(targetPath);
	const stat = fs.lstatSync(resolvedTarget);
	if (stat.isSymbolicLink()) throw new Error(`Refusing to follow symbolic link: ${resolvedTarget}`);
	if (stat.isFile()) {
		if (!/\.md$/i.test(resolvedTarget)) throw new Error(`Target is not a Markdown file: ${resolvedTarget}`);
		return [resolvedTarget];
	}
	if (!stat.isDirectory()) throw new Error(`Target is not a file or directory: ${resolvedTarget}`);

	const markdownFiles = [];
	const visit = (directory) => {
		for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
			const entryPath = path.join(directory, entry.name);
			if (entry.isSymbolicLink()) continue;
			if (entry.isDirectory()) {
				if (!SKIPPED_DIRECTORY_NAMES.has(entry.name.toLowerCase())) visit(entryPath);
			} else if (entry.isFile() && /\.md$/i.test(entry.name)) {
				markdownFiles.push(entryPath);
			}
		}
	};
	visit(resolvedTarget);
	return markdownFiles.sort((left, right) => left.localeCompare(right));
}

export function migrateMasteryFiles(targetPath, { write = false } = {}) {
	const result = { scanned: 0, changed: [], errors: [] };
	for (const filePath of collectMarkdownFiles(targetPath)) {
		result.scanned++;
		try {
			const original = fs.readFileSync(filePath, "utf-8");
			const updated = migrateMasteryFrontmatter(original);
			if (updated === original) continue;
			if (write) fs.writeFileSync(filePath, updated, "utf-8");
			result.changed.push(filePath);
		} catch (error) {
			result.errors.push({
				path: filePath,
				message: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return result;
}

function printUsage() {
	console.log("Usage: node --experimental-strip-types scripts/migrate-mastery-frontmatter.mjs <markdown-file-or-vault> [--dry-run | --write]");
	console.log("Without --write, the script reports which notes would change without modifying them.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	const args = process.argv.slice(2);
	if (args.includes("--help") || args.includes("-h")) {
		printUsage();
	} else {
		const unknownOptions = args.filter((arg) => arg.startsWith("--") && arg !== "--write" && arg !== "--dry-run");
		const write = args.includes("--write");
		const positional = args.filter((arg) => arg !== "--write" && arg !== "--dry-run");
		if (unknownOptions.length > 0 || positional.length !== 1 || (args.includes("--write") && args.includes("--dry-run"))) {
			printUsage();
			process.exitCode = 2;
		} else {
			const result = migrateMasteryFiles(positional[0], { write });
			console.log(`${write ? "Migrated" : "Would migrate"} ${result.changed.length} of ${result.scanned} Markdown note(s).`);
			for (const filePath of result.changed) console.log(`  ${write ? "updated" : "would update"}: ${filePath}`);
			for (const error of result.errors) console.error(`  error: ${error.path}: ${error.message}`);
			if (result.errors.length > 0) process.exitCode = 1;
		}
	}
}
