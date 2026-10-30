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

interface SlotWaiter {
	type: string;
	resolve: () => void;
	signal?: AbortSignal;
	onAbort?: () => void;
}

interface SlotState {
	activeTypes: Set<string>;
	waiters: SlotWaiter[];
}

function state(): SlotState {
	const holder = globalThis as unknown as Record<symbol, SlotState | undefined>;
	holder[STATE_KEY] ??= { activeTypes: new Set(), waiters: [] };
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

export function generatorSlotStatus(): {
	active: number;
	activeTypes: string[];
	limit: number;
	waiting: number;
} {
	const current = state();
	return {
		active: current.activeTypes.size,
		activeTypes: [...current.activeTypes],
		limit: generatorLimit(),
		waiting: current.waiters.length,
	};
}

/**
 * Wait for a global slot not already held by this generator type. The returned
 * release function is idempotent; queued calls reject if their signal aborts.
 */
export async function acquireGeneratorSlot(type: string, signal?: AbortSignal): Promise<() => void> {
	if (!isGeneratorAgentType(type)) throw new Error(`Unknown generator type: ${type}`);

	const current = state();
	if (canAcquire(current, type)) {
		current.activeTypes.add(type);
		return releaseOnce(current, type);
	}
	if (signal?.aborted) throw new Error("Cancelled while waiting for a free generator slot.");

	await new Promise<void>((resolve, reject) => {
		const waiter: SlotWaiter = {
			type,
			signal,
			resolve: () => {
				signal?.removeEventListener("abort", onAbort);
				resolve();
			},
		};
		const onAbort = () => {
			const index = current.waiters.indexOf(waiter);
			if (index < 0) return;
			current.waiters.splice(index, 1);
			reject(new Error("Cancelled while waiting for a free generator slot."));
		};
		waiter.onAbort = onAbort;
		current.waiters.push(waiter);
		signal?.addEventListener("abort", onAbort, { once: true });
	});

	return releaseOnce(current, type);
}

function canAcquire(current: SlotState, type: string): boolean {
	return current.activeTypes.size < generatorLimit() && !current.activeTypes.has(type);
}

function drainWaiters(current: SlotState): void {
	while (current.activeTypes.size < generatorLimit()) {
		const index = current.waiters.findIndex((waiter) => !current.activeTypes.has(waiter.type));
		if (index < 0) return;
		const [waiter] = current.waiters.splice(index, 1);
		current.activeTypes.add(waiter.type);
		waiter.signal?.removeEventListener("abort", waiter.onAbort!);
		waiter.resolve();
	}
}

function releaseOnce(current: SlotState, type: string): () => void {
	let released = false;
	const timer = setTimeout(() => release(), SLOT_TIMEOUT_MS);
	timer.unref?.();
	function release(): void {
		if (released) return;
		released = true;
		clearTimeout(timer);
		current.activeTypes.delete(type);
		drainWaiters(current);
	}
	return release;
}
