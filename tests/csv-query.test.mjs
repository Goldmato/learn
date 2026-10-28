import assert from "node:assert/strict";
import test from "node:test";
import { parseCsv, queryCsv } from "../lib/csv-query.ts";

test("CSV parser handles BOM, CRLF, escaped quotes, delimiters, and multiline values", () => {
	const csv = parseCsv('\uFEFFname,description,value\r\n"Jones, Ada","Said ""hello""\r\nagain",12\r\nSam,plain,7\r\n');
	assert.deepEqual(csv.columns, ["name", "description", "value"]);
	assert.deepEqual(csv.rows, [
		{ rowNumber: 1, values: { name: "Jones, Ada", description: 'Said "hello"\r\nagain', value: "12" } },
		{ rowNumber: 2, values: { name: "Sam", description: "plain", value: "7" } },
	]);
});

test("CSV parser detects tab and semicolon delimiters", () => {
	const tabSeparated = parseCsv('word\tmeaning\n"汉字"\t"Chinese\tcharacters"\n');
	assert.deepEqual(tabSeparated.columns, ["word", "meaning"]);
	assert.equal(tabSeparated.rows[0].values.meaning, "Chinese\tcharacters");

	const semicolonSeparated = parseCsv('word;meaning\n"Jones, Ada";"Said ""hello"""\n');
	assert.deepEqual(semicolonSeparated.columns, ["word", "meaning"]);
	assert.equal(semicolonSeparated.rows[0].values.word, "Jones, Ada");
});

test("CSV parser detects the delimiter from consistent records, not header punctuation", () => {
	const csv = parseCsv("word, phrase\tmeaning\nhello, there\tEnglish\nsimple\tplain\n");
	assert.deepEqual(csv.columns, ["word, phrase", "meaning"]);
	assert.deepEqual(csv.rows.map((row) => row.values.meaning), ["English", "plain"]);
});

test("CSV parser treats omitted trailing fields as empty values", () => {
	const csv = parseCsv("word\tmeaning\tnote\ttags\n汉字\tChinese\n中文\tChinese\tWritten language\t");
	assert.deepEqual(csv.rows[0].values, { word: "汉字", meaning: "Chinese", note: "", tags: "" });
	assert.deepEqual(csv.rows[1].values, { word: "中文", meaning: "Chinese", note: "Written language", tags: "" });
});

test("CSV parser rejects malformed quotes, duplicate headers, and inconsistent records", () => {
	assert.throws(() => parseCsv('name,description\nAda,"not closed'), /inside a quoted field/);
	assert.throws(() => parseCsv("name,name\nAda,Lovelace"), /duplicate column names/);
	assert.throws(() => parseCsv("name,age\nAda,36,extra"), /expected at most 2/);
	assert.throws(() => parseCsv("na\"me,value\nAda,36"), /Unexpected quote/);
	assert.throws(
		() => parseCsv(`${"x".repeat(129)},value\nAda,36`),
		/column 1 is 129 characters; the limit is 128.*supported delimiters are comma, tab, and semicolon/,
	);
});

test("query applies typed field filters, sort order, and bounded row limits", () => {
	const csv = parseCsv("name,group,score\nAda,math,9\nGrace,math,10\nLinus,systems,8\n");
	const result = queryCsv(csv, {
		operation: "query",
		filters: [{ column: "group", operator: "eq", value: "MATH" }],
		sortBy: "score",
		sortOrder: "desc",
		limit: 1,
	});
	assert.equal(result.matchedRows, 2);
	assert.equal(result.rows?.length, 1);
	assert.equal(result.rows?.[0].rowNumber, 2);
	assert.equal(result.rows?.[0].values.name, "Grace");
});

test("search returns lexical relevance scores and respects structured filters", () => {
	const csv = parseCsv(
		"character,role,description\nAda,analyst,Studies data patterns\nGrace,engineer,Builds reliable compilers\nLinus,engineer,Builds a Linux kernel and operating systems\n",
	);
	const result = queryCsv(csv, {
		operation: "search",
		query: "kernel operating system",
		filters: [{ column: "role", operator: "eq", value: "engineer" }],
	});
	assert.equal(result.matchedRows, 1);
	assert.equal(result.rows?.[0].rowNumber, 3);
	assert.ok((result.rows?.[0].score ?? 0) > 0);
});

test("search tokenizes Chinese text into overlapping character pairs and supports single characters", () => {
	const csv = parseCsv("word,meaning\n中文,Chinese writing\n汉字,Chinese characters\n学中文,study Chinese\n");
	const phrase = queryCsv(csv, { operation: "search", query: "正在学中文" });
	assert.equal(phrase.matchedRows, 2);
	assert.equal(phrase.rows?.[0].values.word, "学中文");

	const singleCharacter = queryCsv(csv, { operation: "search", query: "汉" });
	assert.equal(singleCharacter.matchedRows, 1);
	assert.equal(singleCharacter.rows?.[0].values.word, "汉字");
});

test("aggregates support grouped counts and numeric summaries", () => {
	const csv = parseCsv("group,value\nblue,2\nblue,4\nred,5\n");
	const counts = queryCsv(csv, { operation: "query", aggregate: "count", groupBy: "group" });
	assert.deepEqual(counts.groups, [
		{ group: "blue", rows: 2, value: 2 },
		{ group: "red", rows: 1, value: 1 },
	]);
	const average = queryCsv(csv, {
		operation: "query",
		aggregate: "avg",
		groupBy: "group",
		aggregateColumn: "value",
	});
	assert.deepEqual(average.groups, [
		{ group: "blue", rows: 2, value: 3 },
		{ group: "red", rows: 1, value: 5 },
	]);
});

test("search handles a representative 929-line, 11-column CSV without returning the full dataset", () => {
	const columns = Array.from({ length: 11 }, (_, index) => `field_${index + 1}`);
	const data = Array.from({ length: 928 }, (_, index) => {
		const values = Array.from({ length: 11 }, (_, column) => `value ${column} for record ${index + 1}`);
		if (index === 927) values[2] = "contains the rare retrieval phrase";
		return values.join(",");
	});
	const csv = parseCsv([columns.join(","), ...data].join("\n"));
	assert.equal(csv.rows.length, 928);
	const result = queryCsv(csv, { operation: "search", query: "rare retrieval phrase", limit: 1 });
	assert.equal(result.matchedRows, 1);
	assert.equal(result.rows?.length, 1);
	assert.equal(result.rows?.[0].rowNumber, 928);
});

test("query errors identify invalid fields and non-numeric aggregates", () => {
	const csv = parseCsv("name,value\nAda,unknown\n");
	assert.throws(
		() => queryCsv(csv, { operation: "query", filters: [{ column: "missing", operator: "eq", value: "x" }] }),
		/Unknown CSV column/,
	);
	assert.throws(
		() => queryCsv(csv, { operation: "query", aggregate: "sum", aggregateColumn: "value" }),
		/non-numeric value/,
	);
});
