/**
 * Shared concurrency limit for generator subagents.
 *
 * TTS and ComfyUI both saturate the GPU, and the diagram makers are just as
 * expensive, so every generator type draws from one global pool. The counter
 * lives on `globalThis` under a symbol so it stays shared even when extensions
 * are loaded through separate module graphs.
 */

export const GENERATOR_AGENT_TYPES: ReadonlySet<string> = new Set([
	"breeze-tts-maker",
	"comfyui-image-maker",
	"mermaid-maker",
	"svg-maker",
]);

const DEFAULT_LIMIT = 2;
const MAX_LIMIT = 8;
/** Backstop so a lost completion event cannot leak a slot forever. */
const SLOT_TIMEOUT_MS = 20 * 60 * 1000;

const STATE_KEY = Symbol.for("pi.generator-slots.state");

interface SlotState {
	active: number;
	waiters: Array<() => void>;
}

function state(): SlotState {
	const holder = globalThis as unknown as Record<symbol, SlotState | undefined>;
	holder[STATE_KEY] ??= { active: 0, waiters: [] };
	return holder[STATE_KEY]!;
}

export function isGeneratorAgentType(value: unknown): boolean {
	return typeof value === "string" && GENERATOR_AGENT_TYPES.has(value);
}

/** Configured limit, clamped to a sane range. `PI_GENERATOR_CONCURRENCY` overrides it. */
export function generatorLimit(): number {
	const configured = Number.parseInt(process.env.PI_GENERATOR_CONCURRENCY ?? "", 10);
	if (!Number.isFinite(configured)) return DEFAULT_LIMIT;
	return Math.min(MAX_LIMIT, Math.max(1, configured));
}

export function generatorSlotStatus(): { active: number; limit: number; waiting: number } {
	const current = state();
	return { active: current.active, limit: generatorLimit(), waiting: current.waiters.length };
}

/**
 * Wait for a free generator slot. The returned release function is idempotent.
 * Rejects only when the caller's signal aborts while queued.
 */
export async function acquireGeneratorSlot(signal?: AbortSignal): Promise<() => void> {
	const current = state();
	const limit = generatorLimit();
	const cancelled = () => new Error("Cancelled while waiting for a free generator slot.");

	if (current.active < limit) {
		current.active++;
		return releaseOnce(current);
	}
	if (signal?.aborted) throw cancelled();

	await new Promise<void>((resolve, reject) => {
		const waiter = () => {
			signal?.removeEventListener("abort", onAbort);
			// Claim the slot here, not after the await, so a concurrent acquire
			// cannot observe the freed slot as still available.
			current.active++;
			resolve();
		};
		const onAbort = () => {
			const index = current.waiters.indexOf(waiter);
			if (index >= 0) current.waiters.splice(index, 1);
			reject(cancelled());
		};
		current.waiters.push(waiter);
		signal?.addEventListener("abort", onAbort, { once: true });
	});

	return releaseOnce(current);
}

function releaseOnce(current: SlotState): () => void {
	let released = false;
	const timer = setTimeout(() => release(), SLOT_TIMEOUT_MS);
	timer.unref?.();
	function release(): void {
		if (released) return;
		released = true;
		clearTimeout(timer);
		current.active = Math.max(0, current.active - 1);
		current.waiters.shift()?.();
	}
	return release;
}
