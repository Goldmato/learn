import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	buildBackfill,
	replaceManagedTranscript,
	renderTranscript,
} from "../lib/md-log-format.ts";

const localPathsPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "local-paths.json");
let configuredDemoPath;
try {
	const config = JSON.parse(fs.readFileSync(localPathsPath, "utf-8"));
	if (!config || typeof config !== "object" || Array.isArray(config)
		|| config.version !== 1 || typeof config.mdLogDemoOutput !== "string") {
		throw new Error(`Local path config has an invalid mdLogDemoOutput: ${localPathsPath}`);
	}
	configuredDemoPath = config.mdLogDemoOutput.trim()
		? path.resolve(path.dirname(localPathsPath), config.mdLogDemoOutput)
		: undefined;
} catch (error) {
	if (error?.code !== "ENOENT") throw error;
}

export const defaultPath = configuredDemoPath;

export const demoEntries = [
	{ id: "root", type: "session" },
	{
		id: "intro",
		parentId: "root",
		type: "message",
		message: { role: "assistant", content: [{ type: "text", text:
			"This repeatable transcript demo is backfilled from session entries. The managed section updates while text outside its markers is preserved." }] },
	},
	{
		id: "section-start",
		parentId: "intro",
		type: "custom",
		customType: "md-log-section",
		data: { active: true, prefix: "Lesson", title: "From Definitions to Good Claims" },
	},
	{
		id: "lesson",
		parentId: "section-start",
		type: "message",
		message: { role: "assistant", content: [{ type: "text", text: [
			"Start with a **definition**: it fixes how a term is used *in a particular context*; it does not claim the meaning can never change.",
			"",
			"> “A definition tells us how a word is being used here.”",
			"> — Working principle",
			"",
			"Keep essential context visible: ==🔵 A definition is context-bound.== A claim that applies only under a condition needs that condition beside it: ==🟡 State caveats where they change the claim.==",
			"",
			"```ts",
			"function applies(claim, context) {",
			"\treturn claim.conditions.every((condition) => context.includes(condition));",
			"}",
			"```",
			"",
			"Here, `conditions` is part of the claim—not an afterthought.",
		].join("\n") }] },
	},
	{
		id: "quiz-call-1",
		parentId: "lesson",
		type: "message",
		message: { role: "assistant", content: [{
			type: "toolCall",
			id: "demo-quiz-1",
			name: "quiz",
			arguments: {
				question: "Which statement correctly describes a definition?",
				summaryTitle: "Understanding Contextual Definitions",
				details: "Choose the most precise answer.",
				shuffle: false,
				options: [
					{ label: "A term is fixed by an agreed meaning.", value: "contextual" },
					{ label: "A term is whatever a speaker prefers.", value: "arbitrary" },
					{ label: "A term can never change over time.", value: "permanent" },
				],
			},
		}] },
	},
	{
		id: "quiz-result-1",
		parentId: "quiz-call-1",
		type: "message",
		message: { role: "toolResult", toolName: "quiz", toolCallId: "demo-quiz-1", details: {
			status: "answered",
			correct: true,
			correctIndices: [1],
			answers: [{ index: 1, label: "A term is fixed by an agreed meaning." }],
			options: [
				{ index: 1, label: "A term is fixed by an agreed meaning." },
				{ index: 2, label: "A term is whatever a speaker prefers." },
				{ index: 3, label: "A term can never change over time." },
			],
			explanation: "A definition specifies how a term is used in a context; it need not be permanent across every context.",
		} },
	},
	{
		id: "quiz-call-2",
		parentId: "quiz-result-1",
		type: "message",
		message: { role: "assistant", content: [{
			type: "toolCall",
			id: "demo-quiz-2",
			name: "quiz",
			arguments: {
				question: "What should you do with an important caveat?",
				summaryTitle: "Keeping Important Caveats",
				shuffle: false,
				options: [
					{ label: "Ignore it to keep the explanation simple.", value: "ignore" },
					{ label: "State it where it changes how the claim applies.", value: "state" },
				],
			},
		}] },
	},
	{
		id: "quiz-result-2",
		parentId: "quiz-call-2",
		type: "message",
		message: { role: "toolResult", toolName: "quiz", toolCallId: "demo-quiz-2", details: {
			status: "answered",
			correct: false,
			correctIndices: [2],
			answers: [{ index: 1, label: "Ignore it to keep the explanation simple." }],
			options: [
				{ index: 1, label: "Ignore it to keep the explanation simple." },
				{ index: 2, label: "State it where it changes how the claim applies." },
			],
			note: "I thought the caveat could go later.",
			explanation: "A caveat belongs beside the claim it qualifies so the learner does not overgeneralize.",
		} },
	},
	{
		id: "ask-call",
		parentId: "quiz-result-2",
		type: "message",
		message: { role: "assistant", content: [{
			type: "toolCall",
			id: "demo-ask",
			name: "ask_user_question",
			arguments: {
				question: "How would you explain why the caveat belongs beside the claim?",
				summaryTitle: "Explaining Caveat Placement",
				details: "Answer in your own words.",
			},
		}] },
	},
	{
		id: "ask-result",
		parentId: "ask-call",
		type: "message",
		message: { role: "toolResult", toolName: "ask_user_question", toolCallId: "demo-ask", details: {
			status: "answered",
			mode: "text",
			answers: [{ type: "text", label: "So the reader knows exactly when the claim applies." }],
		} },
	},
	{
		id: "section-end",
		parentId: "ask-result",
		type: "custom",
		customType: "md-log-section",
		data: { active: false },
	},
];

export function writeDemo(outputPath = defaultPath) {
	if (!outputPath) {
		throw new Error("Set mdLogDemoOutput in local-paths.json with /configure-paths, or pass --output <path>.");
	}
	const resolvedPath = path.resolve(outputPath);
	const backfill = buildBackfill(demoEntries);
	if (backfill.diagnostics.length > 0) {
		throw new Error(`Demo session backfill failed: ${backfill.diagnostics.join(" ")}`);
	}
	const transcript = renderTranscript(backfill.blocks);
	fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
	const existing = fs.existsSync(resolvedPath)
		? fs.readFileSync(resolvedPath, "utf-8")
		: "# md-log transcript demo\n\nText outside the generated transcript section is preserved.\n";
	const updated = replaceManagedTranscript(existing, transcript);
	fs.writeFileSync(resolvedPath, updated, "utf-8");
	return { path: resolvedPath, transcript, entries: backfill.entries };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	const outputIndex = process.argv.indexOf("--output");
	const outputArgument = outputIndex >= 0 ? process.argv[outputIndex + 1] : undefined;
	if (outputIndex >= 0 && (!outputArgument || outputArgument.startsWith("--"))) {
		throw new Error("Usage: node --experimental-strip-types scripts/md-log-demo.mjs [--output <path>]");
	}
	const result = writeDemo(outputArgument ?? defaultPath);
	console.log(`Demo written to ${result.path} (${result.entries} session entries backfilled)`);
}
