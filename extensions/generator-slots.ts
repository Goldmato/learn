import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	acquireGeneratorSlot,
	generatorSlotStatus,
	isGeneratorAgentType,
} from "../lib/generator-slots.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function generatorTypeOf(input: unknown): string | undefined {
	if (!isRecord(input)) return undefined;
	return isGeneratorAgentType(input.subagent_type) ? input.subagent_type : undefined;
}

/**
 * Serialises generator subagents behind one global limit.
 *
 * Every generator is dispatched through the `Agent` tool — directly for the
 * diagram makers, and nested from `teach_breeze_tts` / `teach_comfyui_paint` —
 * so a single gate here covers all of them. The `tool_call` hook is awaited by
 * pi, which makes this a real queue rather than a block-and-retry.
 */
export default function generatorSlots(pi: ExtensionAPI) {
	/** toolCallId -> release for a dispatch that is still running. */
	const held = new Map<string, { release: () => void; type: string; agentId?: string }>();
	const toolCallsByAgent = new Map<string, string>();
	const earlyCompletions = new Set<string>();

	const release = (toolCallId: string) => {
		const entry = held.get(toolCallId);
		if (!entry) return;
		held.delete(toolCallId);
		if (entry.agentId) toolCallsByAgent.delete(entry.agentId);
		entry.release();
	};

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "Agent") return;
		const type = generatorTypeOf(event.input);
		if (!type) return;

		const status = generatorSlotStatus();
		const queued = status.active >= status.limit || status.activeTypes.includes(type);
		if (queued) ctx.ui.notify(`Waiting for a free generator slot (${type})…`, "info");
		const releaseSlot = await acquireGeneratorSlot(type, ctx.signal);
		held.set(event.toolCallId, { release: releaseSlot, type });
	});

	pi.on("tool_result", (event, ctx) => {
		if (event.toolName !== "Agent" || !generatorTypeOf(event.input)) return;
		// A background dispatch keeps its slot until the completion event.
		if (event.isError || event.input.run_in_background !== true) {
			release(event.toolCallId);
			return;
		}

		const entry = held.get(event.toolCallId);
		const details = isRecord(event.details) ? event.details : undefined;
		const agentId = details?.status === "background" && typeof details.agentId === "string"
			? details.agentId
			: undefined;
		if (!entry || entry.type !== generatorTypeOf(event.input) || !agentId) {
			ctx.ui.notify(
				`Could not match the ${String(generatorTypeOf(event.input))} background job to its generator slot; the slot will remain reserved until completion or timeout.`,
				"error",
			);
			return;
		}

		entry.agentId = agentId;
		toolCallsByAgent.set(agentId, event.toolCallId);
		if (earlyCompletions.delete(agentId)) release(event.toolCallId);
	});

	const onSettled = (data: unknown) => {
		if (!isRecord(data) || !isGeneratorAgentType(data.type) || typeof data.id !== "string") return;
		const toolCallId = toolCallsByAgent.get(data.id);
		if (toolCallId) {
			if (held.get(toolCallId)?.type === data.type) release(toolCallId);
			return;
		}

		if ([...held.values()].some((entry) => entry.type === data.type && !entry.agentId)) {
			earlyCompletions.add(data.id);
		}
	};
	pi.events.on("subagents:completed", onSettled);
	pi.events.on("subagents:failed", onSettled);

	pi.on("session_shutdown", () => {
		for (const entry of held.values()) entry.release();
		held.clear();
		toolCallsByAgent.clear();
		earlyCompletions.clear();
	});

	pi.registerCommand("generator-slots", {
		description: "Show the generator concurrency limit and how many slots are in use",
		handler: (ctx) => {
			const { active, limit, waiting } = generatorSlotStatus();
			const queued = waiting > 0 ? `, ${waiting} queued` : "";
			ctx.ui.notify(`Generator slots: ${active}/${limit} in use${queued}. Set PI_GENERATOR_CONCURRENCY to change the limit.`, "info");
		},
	});
}
