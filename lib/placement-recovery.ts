export type PlacementRecoveryAction = "keep" | "remove" | "show" | "retry" | "other";

export interface PlacementRecoveryMetadata {
	markerId: string;
	anchorId?: string;
	generator: string;
	kind: string;
	status: string;
	notePath?: string;
}

const UUID_PATTERN = /^[a-f0-9-]{36}$/i;

export function placementAnchorMarker(anchorId: string, placementId: string): string {
	if (!UUID_PATTERN.test(anchorId) || !UUID_PATTERN.test(placementId)) {
		throw new Error("Placement anchor IDs must be UUIDs.");
	}
	return `%%pi-placement-anchor:${anchorId}:${placementId}%%`;
}

export function placementAnchorMarkerFromData(data: unknown, placementId: string): string | null | undefined {
	if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
	if (!UUID_PATTERN.test(placementId)) return null;
	const record = data as Record<string, unknown>;
	if (!Object.hasOwn(record, "anchorId")) return undefined;
	return typeof record.anchorId === "string" && UUID_PATTERN.test(record.anchorId)
		? placementAnchorMarker(record.anchorId, placementId)
		: null;
}

export function removePlacementAnchorMarker(markdown: string, placementId: string): string {
	if (!UUID_PATTERN.test(placementId)) throw new Error("Placement ID must be a UUID.");
	const marker = new RegExp(`%%pi-placement-anchor:[a-f0-9-]{36}:${placementId}%%`, "ig");
	return markdown.replace(marker, "");
}

export function placementRecoveryChoices(canRetry: boolean): string[] {
	return [
		"Keep marker unresolved",
		"Remove this marker",
		"Show raw returned text",
		...(canRetry ? ["Retry this request"] : []),
		"Other",
	];
}

export function placementRecoveryAction(choice: string | undefined, canRetry: boolean): PlacementRecoveryAction {
	if (choice?.startsWith("Remove this marker")) return "remove";
	if (choice?.startsWith("Show raw returned text")) return "show";
	if (canRetry && choice?.startsWith("Retry this request")) return "retry";
	if (choice?.startsWith("Other")) return "other";
	return "keep";
}

/** Reconciliation requires the exact anchor and its marker to remain in the managed note. */
export function isPlacementAnchorReconciled(
	markdown: string,
	anchor: string,
	marker: string,
	anchorMarker?: string | null,
): boolean {
	const startMarker = "%% pi-md-log:start v1 %%";
	const endMarker = "%% pi-md-log:end v1 %%";
	const start = markdown.indexOf(startMarker);
	const end = start < 0 ? -1 : markdown.indexOf(endMarker, start + startMarker.length);
	if (start < 0 || end < 0) return false;
	const contentStart = start + startMarker.length;
	const markerIndex = markdown.indexOf(marker, contentStart);
	if (!anchor.trim() || markerIndex < contentStart || markerIndex >= end ||
		markdown.indexOf(marker, markerIndex + marker.length) >= 0) return false;

	const anchorMatches: number[] = [];
	for (let index = markdown.indexOf(anchor, contentStart); index >= contentStart && index + anchor.length <= end;
		index = markdown.indexOf(anchor, index + anchor.length)) {
		anchorMatches.push(index);
	}
	const markerFollowsAnchor = (anchorIndex: number) => markerIndex > anchorIndex &&
		anchorIndex + anchor.length <= end;

	if (anchorMarker === undefined) {
		return anchorMatches.some(markerFollowsAnchor);
	}

	const anchorMarkerIndex = anchorMarker === null ? -1 : markdown.indexOf(anchorMarker, contentStart);
	const anchorMarkerIsUnique = anchorMarkerIndex >= contentStart &&
		anchorMarkerIndex < end &&
		markdown.indexOf(anchorMarker, anchorMarkerIndex + anchorMarker.length) < 0;
	if (anchorMarkerIsUnique) {
		const adjacentAnchor = anchorMatches.find((anchorIndex) =>
			anchorIndex + anchor.length <= anchorMarkerIndex &&
			markdown.slice(anchorIndex + anchor.length, anchorMarkerIndex).trim().length === 0);
		const nextAnchor = adjacentAnchor === undefined
			? undefined
			: anchorMatches.find((anchorIndex) => anchorIndex > adjacentAnchor);
		return adjacentAnchor !== undefined &&
			anchorMarkerIndex < markerIndex &&
			(nextAnchor === undefined || markerIndex < nextAnchor) &&
			markerIndex < end;
	}

	return anchorMatches.length === 1 && markerFollowsAnchor(anchorMatches[0]);
}

export function rawPlacementOutput(event: unknown): string {
	if (!event || typeof event !== "object") return String(event ?? "");
	const value = (event as Record<string, unknown>).result;
	if (typeof value === "string") return value;
	if (value !== undefined) {
		if (value && typeof value === "object" &&
			Object.keys(value as Record<string, unknown>).every((key) => key === "content") &&
			Array.isArray((value as Record<string, unknown>).content)) {
			const text = ((value as { content: unknown[] }).content)
				.filter((part): part is { type: string; text: string } =>
					!!part && typeof part === "object" &&
					(part as Record<string, unknown>).type === "text" &&
					typeof (part as Record<string, unknown>).text === "string")
				.map((part) => part.text)
				.join("\n");
			if (text) return text;
		}
		try {
			return JSON.stringify(value, null, 2) ?? String(value);
		} catch {
			return String(value);
		}
	}
	try {
		return JSON.stringify(event, null, 2) ?? "";
	} catch {
		return String(event);
	}
}

export function sanitizePlacementMetadata(metadata: PlacementRecoveryMetadata): Record<string, string> {
	const clean = (value: string) => value.replace(/[\r\n\t]+/g, " ").replace(/[^\x20-\x7e]/g, "?").slice(0, 300);
	return {
		markerId: clean(metadata.markerId),
		...(metadata.anchorId ? { anchorId: clean(metadata.anchorId) } : {}),
		generator: clean(metadata.generator),
		kind: clean(metadata.kind),
		status: clean(metadata.status),
		...(metadata.notePath ? { noteName: clean(metadata.notePath.replace(/^.*[\\/]/, "")) } : {}),
	};
}
