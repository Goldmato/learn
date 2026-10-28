import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { migrateMasteryFiles } from "../scripts/migrate-mastery-frontmatter.mjs";

test("mastery migration scans vault markdown safely and writes only when requested", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "mastery-migration-"));
	const notePath = path.join(root, "Lessons", "bird.md");
	const ignoredPath = path.join(root, ".obsidian", "metadata.md");
	const note = [
		"---",
		"title: Bird lesson",
		"mastery:",
		"  bird-digestive-tract-order:",
		"    evidence_count: 1",
		"    evidence_weight: 0.9",
		"    confidence: 5",
		"---",
		"",
		"Keep this lesson body.",
	].join("\n");
	fs.mkdirSync(path.dirname(notePath), { recursive: true });
	fs.mkdirSync(path.dirname(ignoredPath), { recursive: true });
	fs.writeFileSync(notePath, note);
	fs.writeFileSync(ignoredPath, note);

	try {
		const preview = migrateMasteryFiles(root);
		assert.equal(preview.scanned, 1);
		assert.deepEqual(preview.changed, [notePath]);
		assert.equal(fs.readFileSync(notePath, "utf-8"), note);

		const migrated = migrateMasteryFiles(root, { write: true });
		assert.equal(migrated.scanned, 1);
		assert.deepEqual(migrated.changed, [notePath]);
		assert.match(fs.readFileSync(notePath, "utf-8"), /^"mastery__bird-digestive-tract-order__evidence-count": 1$/m);
		assert.ok(fs.readFileSync(notePath, "utf-8").endsWith("Keep this lesson body."));
		assert.equal(fs.readFileSync(ignoredPath, "utf-8"), note);

		const repeated = migrateMasteryFiles(root, { write: true });
		assert.equal(repeated.changed.length, 0);
		assert.deepEqual(repeated.errors, []);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
