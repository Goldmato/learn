import assert from "node:assert/strict";
import test from "node:test";
import { displayCsvToolResult, formatCsvDisplay, formatCsvTextPreview } from "../lib/csv-display.ts";

test("display shows every returned field with its original header", () => {
	const text = formatCsvDisplay({
		operation: "search",
		columns: ["id", "created_at", "username", "text", "likes"],
		rows: [{ row_number: 7, values: ["123", "2026-07-26", "goldmato", "The actual post content", "2"] }],
	});
	assert.equal(
		text,
		"Record 7\nid: 123\ncreated_at: 2026-07-26\nusername: goldmato\ntext: The actual post content\nlikes: 2",
	);
});

test("display preserves arbitrary fields and labels empty values", () => {
	assert.equal(
		formatCsvDisplay({
			columns: ["Sort Field", "Created", "field a"],
			rows: [{ values: ["Question", "2024-02-12 @ 09:44", ""] }],
		}),
		"Sort Field: Question\nCreated: 2024-02-12 @ 09:44\nfield a: (empty)",
	);
});

test("display converts grouped aggregates to plain text", () => {
	assert.equal(
		formatCsvDisplay({
			groups: [
				{ group: "biology", rows: 3, value: 8.5 },
				{ group: "history", rows: 2, value: null },
			],
		}),
		"biology: 8.5 (3 rows)\nhistory: no numeric values (2 rows)",
	);
});

test("collapsed display previews content and expanded display returns all content", () => {
	const full = "A".repeat(900);
	const collapsed = formatCsvTextPreview(full, false);
	assert.ok(collapsed.startsWith("A".repeat(700)));
	assert.match(collapsed, /Ctrl\+O to expand/);
	assert.equal(formatCsvTextPreview(full, true), full);
});

test("display strips terminal control characters from CSV values", () => {
	assert.equal(
		formatCsvDisplay({
			columns: ["content"],
			rows: [{ values: ["hello\u001b[31mworld\u0007"] }],
		}),
		"content: helloworld",
	);
});

test("stored CSV result JSON is rendered with all original headers", () => {
	const text = displayCsvToolResult(
		undefined,
		[
			{
				type: "text",
				text: JSON.stringify({
					columns: ["id", "content"],
					rows: [{ row_number: 4, values: ["99", "Recovered entry"] }],
				}),
			},
		],
		true,
	);
	assert.equal(text, "Record 4\nid: 99\ncontent: Recovered entry");
	assert.doesNotMatch(text, /"row_number"|"values"|"columns"/);
});

test("unrecognized JSON tool output is not dumped into the terminal", () => {
	assert.equal(
		displayCsvToolResult(undefined, [{ type: "text", text: '{"secret":"not a CSV result"}' }], true),
		"CSV result is available; rerun the query to display matching entries.",
	);
});
