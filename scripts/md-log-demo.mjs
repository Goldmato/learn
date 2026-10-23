import fs from "node:fs";
import path from "node:path";
import {
	replaceManagedTranscript,
	renderTranscript,
} from "../extensions/md-log-format.ts";

const defaultPath = "C:\\Users\\sambe\\Documents\\Potato Vault\\002-Testing\\md-log-transcript-demo.md";
const outputIndex = process.argv.indexOf("--output");
const outputArgument = outputIndex >= 0 ? process.argv[outputIndex + 1] : undefined;
if (outputIndex >= 0 && (!outputArgument || outputArgument.startsWith("--"))) {
	throw new Error("Usage: node --experimental-strip-types scripts/md-log-demo.mjs [--output <path>]");
}
const outputPath = outputArgument ? path.resolve(outputArgument) : defaultPath;

const blocks = [
	{ kind: "prose", role: "assistant", text: "This is a repeatable demo of the generated transcript section. Existing text outside its hidden markers is preserved." },
	{ kind: "group", active: true, title: "Demo quiz: foundations" },
	{
		kind: "quiz",
		callId: "demo-1",
		question: "Which statement correctly describes a definition?",
		context: "Choose the most precise answer.",
		options: [
			{ index: 1, label: "A term is fixed by an agreed meaning." },
			{ index: 2, label: "A term is whatever a speaker prefers." },
			{ index: 3, label: "A term can never change over time." },
		],
		details: {
			status: "answered",
			correct: true,
			correctIndices: [1],
			answers: [{ index: 1, label: "A term is fixed by an agreed meaning." }],
			explanation: "A definition specifies how a term is used in a context; it does not require that the meaning be permanent in every context.",
		},
	},
	{
		kind: "quiz",
		callId: "demo-2",
		question: "What should you do with an important caveat?",
		options: [
			{ index: 1, label: "Ignore it to keep the explanation simple." },
			{ index: 2, label: "State it where it changes how the claim applies." },
		],
		details: {
			status: "answered",
			correct: false,
			correctIndices: [2],
			answers: [{ index: 1, label: "Ignore it to keep the explanation simple." }],
			explanation: "A caveat belongs beside the claim it qualifies so the learner does not overgeneralize.",
			note: "I thought the caveat could go later.",
		},
	},
	{ kind: "group", active: false },
	{
		kind: "ask",
		callId: "demo-ask",
		question: "Would you prefer another example or a short practice round?",
		options: [
			{ index: 1, label: "Another example" },
			{ index: 2, label: "Practice round" },
		],
		details: { status: "answered", answers: [{ type: "option", index: 2, label: "Practice round" }] },
	},
];

const transcript = renderTranscript(blocks);
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
const existing = fs.existsSync(outputPath)
	? fs.readFileSync(outputPath, "utf-8")
	: "# md-log transcript demo\n\nText outside the generated transcript section is preserved.\n";
fs.writeFileSync(outputPath, replaceManagedTranscript(existing, transcript), "utf-8");
console.log(`Demo written to ${outputPath}`);
