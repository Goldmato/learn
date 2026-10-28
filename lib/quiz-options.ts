export interface QuizOption {
	label: string;
	value: string;
	description?: string;
}

export function normalizeQuizOptions(
	options: Array<{ label: string; value?: string; description?: string }> | undefined,
): QuizOption[] {
	const seen = new Set<string>();
	const normalized = (options || [])
		.map((option) => ({
			label: option.label.trim(),
			value: option.value?.trim() || option.label.trim(),
			description: option.description?.trim() || undefined,
		}))
		.filter((option) => {
			if (option.label.length === 0) return false;
			if (seen.has(option.value)) throw new Error(`duplicate option value "${option.value}"`);
			seen.add(option.value);
			return true;
		});
	if (normalized.length < 4 || normalized.length > 8) {
		throw new Error("requires between 4 and 8 non-empty options");
	}
	return normalized;
}

export function shuffleQuizOptions(options: QuizOption[]): QuizOption[] {
	const shuffled = [...options];
	for (let index = shuffled.length - 1; index > 0; index--) {
		const randomIndex = Math.floor(Math.random() * (index + 1));
		[shuffled[index], shuffled[randomIndex]] = [shuffled[randomIndex], shuffled[index]];
	}
	return shuffled;
}
