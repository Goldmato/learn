import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultPath, demoEntries, writeDemo } from "../scripts/md-log-demo.mjs";
import { buildBackfill, renderTranscript, TRANSCRIPT_END, TRANSCRIPT_START } from "../lib/md-log-format.ts";

test("demo markdown is generated from session backfill with expanded teaching formatting", () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-md-log-transcript-demo-"));
	const notePath = path.join(directory, "md-log-transcript-demo.md");
	try {
		const generated = writeDemo(notePath);
		const note = fs.readFileSync(notePath, "utf-8");
		const backfill = buildBackfill(demoEntries);
		assert.deepEqual(backfill.diagnostics, []);
		assert.equal(generated.entries, demoEntries.length);
		assert.equal(generated.transcript, renderTranscript(backfill.blocks));
		assert.ok(note.startsWith("# md-log transcript demo\n\nText outside the generated transcript section is preserved.\n"));

		const start = note.indexOf(`${TRANSCRIPT_START}\n`);
		const end = note.indexOf(`\n${TRANSCRIPT_END}`, start);
		assert.notEqual(start, -1);
		assert.notEqual(end, -1);
		const managedTranscript = note.slice(start + TRANSCRIPT_START.length + 1, end).replace(/\n$/, "");
		assert.equal(managedTranscript, generated.transcript);

		assert.match(managedTranscript, /^# Lesson: From Definitions to Good Claims$/m);
		assert.match(managedTranscript, /^## Round 1: Understanding Contextual Definitions$/m);
		assert.match(managedTranscript, /^## Round 2: Keeping Important Caveats$/m);
		assert.match(managedTranscript, /^## Question 1: Explaining Caveat Placement$/m);
		assert.match(managedTranscript, /\*\*definition\*\*/);
		assert.match(managedTranscript, /\*in a particular context\*/);
		assert.match(managedTranscript, /^> > “A definition tells us how a word is being used here\.”$/m);
		assert.match(managedTranscript, /```ts[\s\S]*function applies\(claim, context\)/);
		assert.match(managedTranscript, /==🔵 A definition is context-bound\.==/);
		assert.match(managedTranscript, /==🟡 State caveats where they change the claim\.==/);
		assert.match(managedTranscript, /==🟢 A term is fixed by an agreed meaning\.==/);
		assert.match(managedTranscript, /~~==🔴 Ignore it to keep the explanation simple\.==~~/);
		assert.match(managedTranscript, /> \[!example\] Answer/);

		const secondWrite = writeDemo(notePath);
		assert.equal(fs.readFileSync(notePath, "utf-8"), note);
		assert.equal(secondWrite.transcript, generated.transcript);
	} finally {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

test("updated configured demo matches a fresh md-log backfill", { skip: !defaultPath || !fs.existsSync(defaultPath) }, () => {
	const note = fs.readFileSync(defaultPath, "utf-8");
	const backfill = buildBackfill(demoEntries);
	assert.deepEqual(backfill.diagnostics, []);
	const start = note.indexOf(`${TRANSCRIPT_START}\n`);
	const end = note.indexOf(`\n${TRANSCRIPT_END}`, start);
	assert.notEqual(start, -1);
	assert.notEqual(end, -1);
	assert.equal(
		note.slice(start + TRANSCRIPT_START.length + 1, end).replace(/\n$/, ""),
		renderTranscript(backfill.blocks),
	);
});
