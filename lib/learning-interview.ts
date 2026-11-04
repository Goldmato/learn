export interface LearningInterviewQuestion {
	question: string;
	answer: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeLearningInterviewQuestions(value: unknown): string[] {
	if (!Array.isArray(value) || value.length < 3 || value.length > 5) {
		throw new Error("A learning interview must contain 3 to 5 questions.");
	}
	const normalized = value.map((question) => typeof question === "string" ? question.trim() : "");
	if (normalized.some((question) => !question)) {
		throw new Error("Every learning interview question must contain non-whitespace text.");
	}
	if (new Set(normalized.map((question) => question.toLocaleLowerCase())).size !== normalized.length) {
		throw new Error("Learning interview questions must be distinct.");
	}
	return normalized;
}

export function hasCompletedSessionIntake(entries: unknown[]): boolean {
	return entries.some((entry) => {
		if (!isRecord(entry) || entry.type !== "custom" ||
			entry.customType !== "teach-learning-interview" || !isRecord(entry.data)) return false;
		return entry.data.status === "answered" && entry.data.purpose === "session-intake";
	});
}
