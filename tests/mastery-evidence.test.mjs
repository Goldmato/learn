import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
	appendMasteryEvidenceSample,
	masteryEvidenceStorePath,
	mergeMasteryEvidenceEvents,
	readMasteryEvidenceStore,
	replayMasteryEvidence,
	writeMasteryEvidenceStore,
} from "../lib/mastery-evidence.ts";

function sample(conceptId, interactionId, score, recordedAt) {
	return {
		kind: "sample",
		conceptId,
		interactionId,
		evidenceType: "quiz",
		outcome: score === 10 ? "correct" : "incorrect",
		score,
		confidence: 5,
		reasoningSummary: `Evidence ${interactionId}`,
		recordedAt,
	};
}

test("mastery evidence is persisted once and deterministically replayed from ordered samples", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "mastery-evidence-"));
	try {
		let store = { version: 1, events: [] };
		store = appendMasteryEvidenceSample(store, sample("concept", "earlier", 0, 10));
		store = appendMasteryEvidenceSample(store, sample("concept", "later", 10, 20));
		assert.throws(() => appendMasteryEvidenceSample(store, sample("concept", "later", 10, 20)), /already stored/);
		writeMasteryEvidenceStore(root, store);

		const reloaded = readMasteryEvidenceStore(root);
		assert.deepEqual(replayMasteryEvidence(reloaded.events, "concept"), replayMasteryEvidence(store.events, "concept"));
		assert.equal(replayMasteryEvidence(reloaded.events, "concept").evidenceCount, 2);
		assert.equal(replayMasteryEvidence(reloaded.events, "concept").lastInteractionId, "later");
		assert.equal(fs.existsSync(masteryEvidenceStorePath(root)), true);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("legacy baselines preserve existing aggregates and explicitly block unsafe evidence merges", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "mastery-evidence-baseline-"));
	try {
		const store = {
			version: 1,
			events: [{
				kind: "baseline",
				conceptId: "legacy",
				record: { score: 7, evidenceCount: 4, evidenceWeight: 3.9, confidence: 5 },
				recordedAt: 0,
			}],
		};
		writeMasteryEvidenceStore(root, store);
		assert.equal(replayMasteryEvidence(readMasteryEvidenceStore(root).events, "legacy").score, 7);
		assert.throws(() => mergeMasteryEvidenceEvents(store, "legacy", "canonical"), /legacy aggregate baselines/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("evidence store rejects malformed JSON, duplicate samples, and invalid scores", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "mastery-evidence-invalid-"));
	const file = masteryEvidenceStorePath(root);
	try {
		fs.writeFileSync(file, "{", "utf-8");
		assert.throws(() => readMasteryEvidenceStore(root), /Could not read mastery evidence store/);

		for (const store of [
			{ version: 1, events: [sample("concept", "same", 10, 1), sample("concept", "same", 10, 1)] },
			{ version: 1, events: [sample("concept", "bad-score", 12, 1)] },
			{ version: 2, events: [] },
		]) {
			fs.writeFileSync(file, JSON.stringify(store), "utf-8");
			assert.throws(() => readMasteryEvidenceStore(root), /Invalid mastery evidence store/);
		}
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("merging evidence deduplicates identical interaction events and rejects conflicting duplicates", () => {
	const store = {
		version: 1,
		events: [
			sample("source", "same", 10, 1),
			sample("canonical", "same", 10, 1),
			sample("source", "unique", 0, 2),
		],
	};
	const merged = mergeMasteryEvidenceEvents(store, "source", "canonical");
	assert.equal(merged.events.length, 2);
	assert.deepEqual(merged.events.map(({ conceptId }) => conceptId), ["canonical", "canonical"]);

	const conflict = {
		...store,
		events: [sample("source", "same", 10, 1), sample("canonical", "same", 0, 1)],
	};
	assert.throws(() => mergeMasteryEvidenceEvents(conflict, "source", "canonical"), /conflicting evidence/);
});
