import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
	findRelatedMasteryNotes,
	mergeMasteryConceptsAcrossVault,
	previewMasteryConceptMerge,
	scanVaultMastery,
	searchVaultMastery,
	searchVaultMasteryCandidates,
	syncMasteryAcrossVault,
	updateRelatedFrontmatter,
} from "../lib/mastery-vault.ts";
import { updateMasteryFrontmatter, updateTeachingMastery } from "../lib/teach-learning-state.ts";
import { registerMasteryConcept } from "../lib/mastery-concepts.ts";
import { readMasteryEvidenceStore } from "../lib/mastery-evidence.ts";

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
		assert.equal(searchVaultMasteryCandidates(scan, root, "related lesson", 10)[0].id, "shared-concept");
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

test("mastery sync propagates the latest frontmatter record to related notes without HTML evidence", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "mastery-vault-sync-"));
	const noteA = path.join(root, "A.md");
	const noteB = path.join(root, "B.md");
	fs.mkdirSync(path.join(root, ".obsidian"));
	try {
		const shared = { score: 7, evidenceCount: 2, evidenceWeight: 2, lastInteractionId: "attempt-a", confidence: 6 };
		fs.writeFileSync(noteA, updateMasteryFrontmatter("---\ntitle: A\n---\nBody A.", "shared", shared));
		fs.writeFileSync(noteB, updateMasteryFrontmatter("---\ntitle: B\n---\nBody B.", "shared", shared));

		const evidence = { conceptId: "shared", interactionId: "attempt-b", score: 9, confidence: 8, recordedAt: 200 };
		const result = syncMasteryAcrossVault(root, noteA, "shared", { evidence });
		assert.deepEqual(result.record, updateTeachingMastery(shared, evidence));
		assert.equal(result.evidenceCount, 3);
		assert.deepEqual(result.files.sort(), [noteA, noteB].sort());
		for (const file of [noteA, noteB]) {
			const updated = fs.readFileSync(file, "utf-8");
			assert.match(updated, /"mastery__shared__evidence-count": 3/);
			assert.match(updated, /related:\n  - "\[\[(?:A|B)\]\]"/);
			assert.doesNotMatch(updated, /pi-mastery-evidence/);
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

		assert.throws(() => syncMasteryAcrossVault(root, noteA, "shared"), /differ between linked notes/);
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

test("legacy HTML evidence blocks never block a new mastery sync", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "mastery-vault-legacy-"));
	const note = path.join(root, "Lesson.md");
	fs.mkdirSync(path.join(root, ".obsidian"));
	try {
		const legacy = [
			"<!-- pi-mastery-evidence:start v1 -->",
			'<!-- pi-mastery-evidence:v1 {"interactionId":"old-1","conceptId":"shared","score":10,"confidence":8,"recordedAt":1} -->',
			"<!-- pi-mastery-evidence:end v1 -->",
			"<!-- pi-mastery-evidence:start v1 -->",
			"<!-- pi-mastery-evidence:end v1 -->",
		].join("\n");
		const existing = updateMasteryFrontmatter(`---\ntitle: Lesson\n---\n${legacy}\n\nBody.`, "shared", {
			score: 9, evidenceCount: 1, evidenceWeight: 1, lastInteractionId: "old-1", confidence: 8,
		});
		fs.writeFileSync(note, existing);
		const evidence = { conceptId: "shared", interactionId: "new-2", score: 4, confidence: 5, recordedAt: 2 };
		const result = syncMasteryAcrossVault(root, note, "shared", { evidence });
		assert.equal(result.record.evidenceCount, 2);
		assert.match(fs.readFileSync(note, "utf-8"), /"mastery__shared__evidence-count": 2/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("mastery merge preview replays complete event histories and rewrites only approved concept references", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "mastery-vault-merge-"));
	const sourceNote = path.join(root, "Old", "lesson.md");
	const canonicalNote = path.join(root, "Current", "lesson.md");
	fs.mkdirSync(path.join(root, ".obsidian"));
	fs.mkdirSync(path.dirname(sourceNote), { recursive: true });
	fs.mkdirSync(path.dirname(canonicalNote), { recursive: true });
	try {
		fs.writeFileSync(sourceNote, "---\ntitle: Old lesson\n---\nKeep source prose.", "utf-8");
		fs.writeFileSync(canonicalNote, "---\ntitle: Current lesson\n---\nKeep target prose.", "utf-8");
		registerMasteryConcept(root, {
			id: "old-policy-reading",
			name: "Policy reading",
			subjectPath: ["Chinese", "Reading"],
			definition: "Read policy statements in context.",
			aliases: ["policy interpretation"],
		});
		registerMasteryConcept(root, {
			id: "chinese-policy-comprehension",
			name: "Chinese policy comprehension",
			subjectPath: ["Chinese", "Reading comprehension"],
			definition: "Understand policy statements in Chinese.",
			aliases: ["policy comprehension"],
		});
		const sourceEvidence = {
			conceptId: "old-policy-reading",
			interactionId: "source-attempt",
			evidenceType: "quiz",
			outcome: "correct",
			score: 10,
			confidence: 5,
			recordedAt: 10,
		};
		const sourceNext = updateTeachingMastery(undefined, sourceEvidence);
		syncMasteryAcrossVault(root, sourceNote, sourceEvidence.conceptId, {
			nextRecord: sourceNext,
			evidence: sourceEvidence,
		});
		const targetEvidence = {
			conceptId: "chinese-policy-comprehension",
			interactionId: "canonical-attempt",
			evidenceType: "quiz",
			outcome: "incorrect",
			score: 0,
			confidence: 5,
			recordedAt: 20,
		};
		const targetNext = updateTeachingMastery(undefined, targetEvidence);
		syncMasteryAcrossVault(root, canonicalNote, targetEvidence.conceptId, {
			nextRecord: targetNext,
			evidence: targetEvidence,
		});

		const preview = previewMasteryConceptMerge(root, "old-policy-reading", "chinese-policy-comprehension");
		assert.equal(preview.canMerge, true);
		assert.equal(preview.sourceEvidenceCount, 1);
		assert.equal(preview.canonicalEvidenceCount, 1);
		assert.equal(preview.mergedEvidenceCount, 2);
		assert.deepEqual(preview.affectedNotePaths.sort(), [path.join("Current", "lesson.md"), path.join("Old", "lesson.md")].sort());

		fs.appendFileSync(canonicalNote, "\nChanged after preview.", "utf-8");
		assert.throws(
			() => mergeMasteryConceptsAcrossVault(root, "old-policy-reading", "chinese-policy-comprehension", preview.previewToken),
			/changed after preview/,
		);
		assert.match(fs.readFileSync(sourceNote, "utf-8"), /mastery__old-policy-reading__evidence-count/);

		const freshPreview = previewMasteryConceptMerge(root, "old-policy-reading", "chinese-policy-comprehension");
		const merged = mergeMasteryConceptsAcrossVault(root, "old-policy-reading", "chinese-policy-comprehension", freshPreview.previewToken);
		assert.equal(merged.preview.mergedEvidenceCount, 2);
		assert.equal(merged.files.length, 2);
		for (const file of [sourceNote, canonicalNote]) {
			const markdown = fs.readFileSync(file, "utf-8");
			assert.doesNotMatch(markdown, /mastery__old-policy-reading__/);
			assert.match(markdown, /mastery__chinese-policy-comprehension__evidence-count": 2/);
			assert.match(markdown, /Keep (?:source|target) prose\./);
		}
		const evidence = readMasteryEvidenceStore(root);
		assert.equal(evidence.events.length, 2);
		assert.ok(evidence.events.every((event) => event.conceptId === "chinese-policy-comprehension"));
		const mergedAgain = previewMasteryConceptMerge(root, "old-policy-reading", "chinese-policy-comprehension");
		assert.equal(mergedAgain.canMerge, false);
		assert.match(mergedAgain.blockers.join(" "), /already merged/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("mastery merge preview blocks legacy aggregates without replayable evidence", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "mastery-vault-merge-legacy-"));
	const note = path.join(root, "Lesson.md");
	fs.mkdirSync(path.join(root, ".obsidian"));
	try {
		registerMasteryConcept(root, {
			id: "legacy-concept",
			name: "Legacy concept",
			subjectPath: ["Subject"],
			definition: "An old mastery aggregate.",
		});
		registerMasteryConcept(root, {
			id: "canonical-concept",
			name: "Canonical concept",
			subjectPath: ["Subject"],
			definition: "The target concept.",
		});
		fs.writeFileSync(note, updateMasteryFrontmatter("---\ntitle: Legacy\n---\nBody.", "legacy-concept", {
			score: 7,
			evidenceCount: 4,
			evidenceWeight: 3.9,
			lastInteractionId: "old",
			confidence: 5,
		}));
		const preview = previewMasteryConceptMerge(root, "legacy-concept", "canonical-concept");
		assert.equal(preview.canMerge, false);
		assert.match(preview.blockers.join(" "), /no replayable evidence events/);
		assert.throws(
			() => mergeMasteryConceptsAcrossVault(root, "legacy-concept", "canonical-concept", preview.previewToken),
			/blocked/,
		);
		assert.match(fs.readFileSync(note, "utf-8"), /mastery__legacy-concept__score": 7/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
