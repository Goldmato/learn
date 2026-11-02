import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
	masteryConceptCatalogPath,
	mergeMasteryConceptCatalogEntries,
	readMasteryConceptCatalog,
	registerMasteryConcept,
	resolveMasteryConceptId,
	rankMasteryConceptCandidates,
	searchMasteryConceptCatalog,
} from "../lib/mastery-concepts.ts";

function concept(id, overrides = {}) {
	return {
		id,
		name: "Reading policy vocabulary in context",
		subjectPath: ["Chinese", "Vocabulary", "Reading comprehension"],
		definition: "Infer the meaning of policy-related vocabulary from its sentence context.",
		aliases: ["contextual vocabulary reading"],
		...overrides,
	};
}

test("mastery concept catalogue is created lazily and supports canonical metadata and hierarchy", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "mastery-concepts-"));
	try {
		assert.deepEqual(readMasteryConceptCatalog(root), { version: 1, concepts: [] });
		assert.equal(fs.existsSync(masteryConceptCatalogPath(root)), false);

		registerMasteryConcept(root, concept("chinese-reading"));
		const child = registerMasteryConcept(root, concept("policy-vocabulary", {
			name: "Policy vocabulary in context",
			subjectPath: ["Chinese", "Vocabulary", "Policy language"],
			parentId: "chinese-reading",
			aliases: ["reading policy terms"],
		}));
		assert.equal(child.catalog.concepts.length, 2);
		assert.equal(child.concept.parentId, "chinese-reading");

		const persisted = JSON.parse(fs.readFileSync(masteryConceptCatalogPath(root), "utf-8"));
		assert.equal(persisted.version, 1);
		assert.equal(persisted.concepts[1].parentId, "chinese-reading");
		assert.equal(fs.readdirSync(root).length, 1);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("mastery concept search includes names, aliases, definitions, and subject paths", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "mastery-concepts-search-"));
	try {
		registerMasteryConcept(root, concept("policy-vocabulary"));
		const catalog = readMasteryConceptCatalog(root);
		assert.equal(searchMasteryConceptCatalog(catalog, "contextual vocabulary").concepts[0].id, "policy-vocabulary");
		assert.equal(searchMasteryConceptCatalog(catalog, "Chinese").total, 1);
		assert.equal(searchMasteryConceptCatalog(catalog, "unrelated").total, 0);
		assert.throws(() => searchMasteryConceptCatalog(catalog, "", 0), /limit must be an integer/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("catalogue registration rejects duplicate IDs and invalid parent references without overwriting", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "mastery-concepts-safe-"));
	try {
		registerMasteryConcept(root, concept("chinese-reading"));
		const original = fs.readFileSync(masteryConceptCatalogPath(root), "utf-8");
		assert.throws(() => registerMasteryConcept(root, concept("chinese-reading", { name: "Different concept" })), /already registered/);
		assert.throws(() => registerMasteryConcept(root, concept("orphaned-concept", { parentId: "missing-parent" })), /must be registered before/);
		assert.equal(fs.readFileSync(masteryConceptCatalogPath(root), "utf-8"), original);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("catalogue reader reports malformed data, duplicate IDs, missing parents, and cycles", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "mastery-concepts-invalid-"));
	const file = masteryConceptCatalogPath(root);
	try {
		fs.writeFileSync(file, "{", "utf-8");
		assert.throws(() => readMasteryConceptCatalog(root), /Could not read mastery concept catalogue/);

		for (const concepts of [
			[concept("same-id"), concept("same-id")],
			[concept("child-concept", { parentId: "missing-parent" })],
			[
				concept("parent-concept", { parentId: "child-concept" }),
				concept("child-concept", { parentId: "parent-concept" }),
			],
			[concept("Invalid_ID")],
			[concept("known-concept", { unrecognizedField: "preserve me" })],
		]) {
			fs.writeFileSync(file, JSON.stringify({ version: 1, concepts }), "utf-8");
			assert.throws(() => readMasteryConceptCatalog(root), /Invalid mastery concept catalogue/);
		}
		fs.writeFileSync(file, JSON.stringify({ version: 1, concepts: [], futureData: "preserve me" }), "utf-8");
		assert.throws(() => readMasteryConceptCatalog(root), /Invalid mastery concept catalogue/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("mastery candidate search ranks aliases and subjects without selecting or merging a concept", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "mastery-concepts-candidates-"));
	try {
		registerMasteryConcept(root, concept("policy-vocabulary"));
		registerMasteryConcept(root, concept("cell-division", {
			name: "Cell division stages",
			subjectPath: ["Biology", "Cell biology"],
			definition: "Identify the ordered stages of cell division.",
			aliases: ["mitosis sequence"],
		}));
		const catalog = readMasteryConceptCatalog(root);
		const aliasMatches = rankMasteryConceptCandidates("mitosis sequence", catalog, [], 10);
		assert.equal(aliasMatches[0].id, "cell-division");
		assert.equal(aliasMatches[0].score, 100);
		assert.deepEqual(aliasMatches[0].matchedOn, ["alias: mitosis sequence"]);
		assert.equal(rankMasteryConceptCandidates("biology", catalog, [], 10)[0].id, "cell-division");
		assert.equal(rankMasteryConceptCandidates("unrelated", catalog, [], 10).length, 0);
		assert.equal(rankMasteryConceptCandidates("", catalog, [], 10).length, 2);
		assert.equal(resolveMasteryConceptId(catalog, "policy-vocabulary"), "policy-vocabulary");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("catalogue concept merge redirects old IDs and preserves source labels as target aliases", () => {
	const catalog = {
		version: 1,
		concepts: [
			concept("vocabulary-in-context", { aliases: ["context vocabulary"] }),
			concept("chinese-policy-terms", {
				name: "Chinese policy terms",
				aliases: ["policy vocabulary", "context vocabulary"],
			}),
		],
	};
	const merged = mergeMasteryConceptCatalogEntries(catalog, "chinese-policy-terms", "vocabulary-in-context");
	assert.equal(resolveMasteryConceptId(merged, "chinese-policy-terms"), "vocabulary-in-context");
	assert.equal(merged.concepts.find(({ id }) => id === "chinese-policy-terms").mergedInto, "vocabulary-in-context");
	assert.deepEqual(merged.concepts.find(({ id }) => id === "vocabulary-in-context").aliases, [
		"context vocabulary",
		"Chinese policy terms",
		"policy vocabulary",
	]);
});
