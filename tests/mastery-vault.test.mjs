import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
	extractMasteryEvidence,
	findRelatedMasteryNotes,
	mergeMasteryEvidence,
	scanVaultMastery,
	searchVaultMastery,
	syncMasteryAcrossVault,
	updateRelatedFrontmatter,
	updateMasteryEvidence,
} from "../lib/mastery-vault.ts";
import { updateMasteryFrontmatter, updateTeachingMastery } from "../lib/teach-learning-state.ts";

test("vault mastery scan finds exact shared concept IDs and skips tooling directories", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "mastery-vault-scan-"));
	const note = (title, conceptId, score) => [
		"---",
		`title: ${title}`,
		`"mastery__${conceptId}__evidence-count": 3`,
		`"mastery__${conceptId}__evidence-weight": 3`,
		`"mastery__${conceptId}__confidence": 5`,
		`"mastery__${conceptId}__score": ${score}`,
		"---",
		"",
	].join("\n");
	try {
		const active = path.join(root, "Lessons", "active.md");
		const related = path.join(root, "Other", "related.md");
		const unrelated = path.join(root, "Other", "unrelated.md");
		const ignored = path.join(root, ".obsidian", "ignored.md");
		for (const file of [active, related, unrelated, ignored]) fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(active, note("Active lesson", "shared-concept", 7));
		fs.writeFileSync(related, note("Related lesson", "shared-concept", 6));
		fs.writeFileSync(unrelated, note("Other lesson", "different-concept", 8));
		fs.writeFileSync(ignored, note("Ignored", "shared-concept", 5));

		const scan = scanVaultMastery(root);
		assert.deepEqual(scan.diagnostics, []);
		const found = findRelatedMasteryNotes(scan, active);
		assert.equal(found.current.title, "Active lesson");
		assert.deepEqual(found.related.map((item) => item.relativePath), [path.join("Other", "related.md")]);
		assert.equal(found.related[0].mastery.get("shared-concept").score, 6);
		assert.equal(searchVaultMastery(scan, "related lesson").concepts[0].conceptId, "shared-concept");
		assert.equal(searchVaultMastery(scan, "different-concept", 1).total, 1);
		assert.throws(() => searchVaultMastery(scan, "", 0), /limit must be an integer/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("related frontmatter merges Obsidian links without replacing existing properties", () => {
	const original = [
		"---",
		"title: Lesson",
		"related:",
		'  - "[[Earlier Note]]"',
		"tags:",
		"  - biology",
		"---",
		"",
		"Authored body.",
	].join("\n");
	const updated = updateRelatedFrontmatter(original, ["Other/Note", "Earlier Note"]);
	assert.match(updated, /^related:\n  - "\[\[Earlier Note\]\]"\n  - "\[\[Other\/Note\]\]"\ntags:\n  - biology$/m);
	assert.ok(updated.endsWith("Authored body."));
	assert.equal(updateRelatedFrontmatter(updated, ["Other/Note"]), updated);
});

test("related frontmatter supports new and existing inline properties", () => {
	const created = updateRelatedFrontmatter("# Note\n\nBody.", ["Related"]);
	assert.match(created, /^---\nrelated:\n  - "\[\[Related\]\]"\n---\n\n# Note/m);

	const inline = updateRelatedFrontmatter('---\ntitle: Lesson\nrelated: "[[First]]"\n---\nBody.', ["Second"]);
	assert.match(inline, /^related:\n  - "\[\[First\]\]"\n  - "\[\[Second\]\]"/m);
	assert.ok(inline.endsWith("Body."));
});

test("related frontmatter refuses to overwrite unsupported shapes", () => {
	assert.throws(
		() => updateRelatedFrontmatter("---\nrelated:\n  - [[Unquoted]]\n  property: nested\n---\nBody.", ["Other"]),
		/Unsupported .*related.* frontmatter/,
	);
});

test("mastery evidence is unioned and replayed across related notes", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "mastery-vault-sync-"));
	const noteA = path.join(root, "A.md");
	const noteB = path.join(root, "B.md");
	fs.mkdirSync(path.join(root, ".obsidian"));
	try {
		const evidenceA = { conceptId: "shared", interactionId: "attempt-a", score: 10, confidence: 8, recordedAt: 100 };
		const evidenceB = { conceptId: "shared", interactionId: "attempt-b", score: 2, confidence: 4, recordedAt: 200 };
		let markdownA = updateMasteryFrontmatter("---\ntitle: A\n---\nBody A.", "shared", {
			evidenceCount: 1, evidenceWeight: 0.96, evidenceSum: 9.6, lastInteractionId: "attempt-a", confidence: 8,
		});
		let markdownB = updateMasteryFrontmatter("---\ntitle: B\n---\nBody B.", "shared", {
			evidenceCount: 1, evidenceWeight: 0.88, evidenceSum: 1.76, lastInteractionId: "attempt-b", confidence: 4,
		});
		markdownA = updateMasteryEvidence(markdownA, [evidenceA]);
		markdownB = updateMasteryEvidence(markdownB, [evidenceB]);
		fs.writeFileSync(noteA, markdownA);
		fs.writeFileSync(noteB, markdownB);

		const result = syncMasteryAcrossVault(root, noteA, "shared");
		const expected = mergeMasteryEvidence([evidenceA, evidenceB]).record;
		assert.deepEqual(result.record, expected);
		assert.equal(result.evidenceCount, 2);
		assert.deepEqual(result.files.sort(), [noteA, noteB].sort());
		for (const file of [noteA, noteB]) {
			const updated = fs.readFileSync(file, "utf-8");
			assert.deepEqual(extractMasteryEvidence(updated, "shared").map((item) => item.interactionId), ["attempt-a", "attempt-b"]);
			assert.match(updated, /"mastery__shared__evidence-count": 2/);
			assert.match(updated, /related:\n  - "\[\[(?:A|B)\]\]"/);
		}
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("mastery sync refuses to guess when histories conflict and cannot be reconstructed", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "mastery-vault-conflict-"));
	const noteA = path.join(root, "A.md");
	const noteB = path.join(root, "B.md");
	fs.mkdirSync(path.join(root, ".obsidian"));
	try {
		const originalA = updateMasteryFrontmatter("---\ntitle: A\n---\nBody A.", "shared", {
			score: 8, evidenceCount: 3, evidenceWeight: 3, lastInteractionId: "attempt-a", confidence: 6,
		});
		const originalB = updateMasteryFrontmatter("---\ntitle: B\n---\nBody B.", "shared", {
			score: 4, evidenceCount: 5, evidenceWeight: 4.8, lastInteractionId: "attempt-b", confidence: 5,
		});
		fs.writeFileSync(noteA, originalA);
		fs.writeFileSync(noteB, originalB);

		assert.throws(() => syncMasteryAcrossVault(root, noteA, "shared"), /do not contain complete interaction evidence/);
		assert.equal(fs.readFileSync(noteA, "utf-8"), originalA);
		assert.equal(fs.readFileSync(noteB, "utf-8"), originalB);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("mastery sync inherits an existing vault concept when the active note is new to it", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "mastery-vault-reuse-"));
	const current = path.join(root, "Current.md");
	const existing = path.join(root, "Existing.md");
	fs.mkdirSync(path.join(root, ".obsidian"));
	try {
		fs.writeFileSync(current, "---\ntitle: Current\n---\nNew lesson.");
		const previousRecord = {
			score: 7,
			evidenceCount: 3,
			evidenceWeight: 3,
			lastInteractionId: "attempt-3",
			confidence: 5,
		};
		fs.writeFileSync(existing, updateMasteryFrontmatter("---\ntitle: Existing\n---\nExisting lesson.", "shared", previousRecord));
		const evidence = { conceptId: "shared", interactionId: "attempt-4", score: 9, confidence: 8, recordedAt: 400 };

		const result = syncMasteryAcrossVault(root, current, "shared", { evidence });
		assert.deepEqual(result.previousRecord, previousRecord);
		assert.deepEqual(result.record, updateTeachingMastery(previousRecord, evidence));
		assert.match(fs.readFileSync(current, "utf-8"), /"mastery__shared__evidence-count": 4/);
		assert.match(fs.readFileSync(current, "utf-8"), /related:\n  - "\[\[Existing\]\]"/);
		assert.match(fs.readFileSync(existing, "utf-8"), /related:\n  - "\[\[Current\]\]"/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("mastery sync replays complete conflicting histories when the active note has no record", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "mastery-vault-complete-histories-"));
	const current = path.join(root, "Current.md");
	const noteA = path.join(root, "A.md");
	const noteB = path.join(root, "B.md");
	fs.mkdirSync(path.join(root, ".obsidian"));
	try {
		const evidenceA = [8, 6, 9].map((score, index) => ({
			conceptId: "shared",
			interactionId: `a-${index}`,
			score,
			confidence: 7,
			recordedAt: 100 + index,
		}));
		const evidenceB = [2, 4, 3].map((score, index) => ({
			conceptId: "shared",
			interactionId: `b-${index}`,
			score,
			confidence: 5,
			recordedAt: 200 + index,
		}));
		const createNote = (title, evidence) => {
			let markdown = updateMasteryFrontmatter(`---\ntitle: ${title}\n---\n${title}.`, "shared", mergeMasteryEvidence(evidence).record);
			markdown = updateMasteryEvidence(markdown, evidence);
			return markdown;
		};
		fs.writeFileSync(current, "---\ntitle: Current\n---\nNew lesson.");
		fs.writeFileSync(noteA, createNote("A", evidenceA));
		fs.writeFileSync(noteB, createNote("B", evidenceB));
		const incoming = { conceptId: "shared", interactionId: "current-1", score: 10, confidence: 9, recordedAt: 300 };

		const result = syncMasteryAcrossVault(root, current, "shared", { evidence: incoming });
		const expected = mergeMasteryEvidence([...evidenceA, ...evidenceB, incoming]).record;
		assert.deepEqual(result.record, expected);
		assert.equal(result.evidenceCount, 7);
		assert.deepEqual(result.previousRecord, mergeMasteryEvidence([...evidenceA, ...evidenceB]).record);
		for (const file of [current, noteA, noteB]) {
			assert.deepEqual(
				extractMasteryEvidence(fs.readFileSync(file, "utf-8"), "shared").map((item) => item.interactionId),
				["a-0", "a-1", "a-2", "b-0", "b-1", "b-2", "current-1"],
			);
		}
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
