import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	placementRecoveryAction,
	placementRecoveryChoices,
	rawPlacementOutput,
	sanitizePlacementMetadata,
	type PlacementRecoveryAction,
	type PlacementRecoveryMetadata,
} from "./placement-recovery.ts";

export interface PlacementRecoveryActions {
	canRetry?: boolean;
	remove(): void | Promise<void>;
	retry?(): void | Promise<void>;
	writeDiagnostic?: (metadata: PlacementRecoveryMetadata, output: string) => string;
}

let recoveryDialogQueue: Promise<void> = Promise.resolve();

export function writePlacementDiagnostic(
	metadata: PlacementRecoveryMetadata,
	output: string,
	writeFile: typeof fs.writeFileSync = fs.writeFileSync,
): string {
	const filePath = path.join(os.tmpdir(), `pi-placement-recovery-${randomUUID()}.json`);
	writeFile(filePath, JSON.stringify({
		metadata: sanitizePlacementMetadata(metadata),
		generatorOutput: output,
	}, null, 2), { encoding: "utf-8", flag: "wx" });
	return filePath;
}

async function runPlacementRecovery(
	ctx: any,
	metadata: PlacementRecoveryMetadata,
	event: unknown,
	actions: PlacementRecoveryActions,
): Promise<PlacementRecoveryAction> {
	const notify = (message: string, level: "info" | "warning" | "error") => {
		try { ctx.ui?.notify?.(message, level); } catch { /* Notification failures must not alter marker recovery. */ }
	};
	const output = rawPlacementOutput(event);
	let diagnosticPath: string | undefined;
	try {
		diagnosticPath = actions.writeDiagnostic
			? actions.writeDiagnostic(metadata, output)
			: writePlacementDiagnostic(metadata, output);
		notify(`Placement diagnostic saved to: ${diagnosticPath}. Forward this file if you need help.`, "warning");
	} catch (error) {
		notify(`Could not write the placement diagnostic (${error instanceof Error ? error.message : String(error)}). The marker will remain unless you explicitly remove it.`, "error");
	}

	if (typeof ctx.ui?.select !== "function") {
		notify(`Placement ${metadata.markerId} remains unresolved; its marker was preserved.`, "warning");
		return "keep";
	}
	const choices = placementRecoveryChoices(Boolean(actions.canRetry && actions.retry));
	for (;;) {
		let choice: string | undefined;
		try {
			choice = await ctx.ui.select(
				`Could not place ${metadata.kind} for marker ${metadata.markerId}. Choose an action for this marker only.`,
				choices,
			);
		} catch (error) {
			notify(`Placement recovery was interrupted; marker ${metadata.markerId} remains unresolved.`, "warning");
			return "keep";
		}
		const action = placementRecoveryAction(choice, Boolean(actions.canRetry && actions.retry));
		if (action === "show") {
			try {
				await ctx.ui.select(
					`Raw generator output for marker ${metadata.markerId}:\n\n${output || "(No output was returned.)"}`,
					["Return to placement recovery"],
				);
			} catch {
				notify(output || "(No output was returned.)", "info");
			}
			continue;
		}
		if (action === "remove" || action === "retry") return action;
		if (action === "other" && typeof ctx.ui.input === "function") {
			try { await ctx.ui.input("Other action (no automatic changes will be made)", ""); } catch { /* Keep unresolved on input cancellation. */ }
		}
		notify(`Placement ${metadata.markerId} remains unresolved; its marker was preserved.`, "warning");
		return "keep";
	}
}

export function recoverUnresolvedPlacement(
	ctx: any,
	metadata: PlacementRecoveryMetadata,
	event: unknown,
	actions: PlacementRecoveryActions,
): Promise<void> {
	const previous = recoveryDialogQueue;
	let release!: () => void;
	recoveryDialogQueue = new Promise<void>((resolve) => { release = resolve; });
	return previous.then(async () => {
		let action: PlacementRecoveryAction = "keep";
		try {
			action = await runPlacementRecovery(ctx, metadata, event, actions);
		} finally {
			release();
		}
		const notify = (message: string, level: "info" | "warning" | "error") => {
			try { ctx.ui?.notify?.(message, level); } catch { /* Notification failures must not alter marker recovery. */ }
		};
		if (action === "remove") {
			try {
				await actions.remove();
				notify(`Only marker ${metadata.markerId} was removed by your choice.`, "info");
			} catch (error) {
				notify(`Marker ${metadata.markerId} was not removed: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
			return;
		}
		if (action === "retry") {
			try {
				await actions.retry?.();
			} catch (error) {
				notify(`Retry could not start; marker ${metadata.markerId} remains unresolved: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		}
	});
}
