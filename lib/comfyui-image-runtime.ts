import { comfyFetch, getObjectInfo } from "../npm/node_modules/pi-comfyui-paint/src/comfyui-client.ts";
import {
	MOSS_STEP_OPTIONS,
	validateMossWorkflowRuntime,
} from "./comfyui-image-policy.ts";

export async function preflightMossBackend(
	backend: { id: string; url: string },
	workflow: Readonly<Record<string, unknown>>,
	steps: typeof MOSS_STEP_OPTIONS[number],
	signal?: AbortSignal,
): Promise<void> {
	const timeout = AbortSignal.timeout(20_000);
	const preflightSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
	try {
		const [objectInfo, rawLoras] = await Promise.all([
			getObjectInfo(backend.url, preflightSignal),
			comfyFetch(backend.url, "/models/loras", { signal: preflightSignal }),
		]);
		if (!Array.isArray(rawLoras) || !rawLoras.every((lora) => typeof lora === "string")) {
			throw new Error("ComfyUI returned an invalid LoRA model list.");
		}
		validateMossWorkflowRuntime(workflow, objectInfo, rawLoras, steps);
	} catch (error) {
		if (signal?.aborted) {
			throw signal.reason instanceof Error ? signal.reason : new Error("MOSS preflight was cancelled.");
		}
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(`MOSS preflight failed on ComfyUI backend "${backend.id}":\n${reason}`);
	}
}
