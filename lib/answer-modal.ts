import type { OverlayHandle } from "@mariozechner/pi-tui";

interface AnswerModalState {
	handle?: OverlayHandle;
	suspended: boolean;
	cancel?: () => void;
	snapshot?: () => string;
}

const STATE_KEY = "__piAnswerModalState";

function getState(): AnswerModalState {
	const root = globalThis as typeof globalThis & { [STATE_KEY]?: AnswerModalState };
	root[STATE_KEY] ??= { suspended: false };
	return root[STATE_KEY];
}

export function trackAnswerModal(
	handle: OverlayHandle,
	controls?: { cancel?: () => void; snapshot?: () => string },
): void {
	const state = getState();
	state.handle = handle;
	state.suspended = false;
	state.cancel = controls?.cancel;
	state.snapshot = controls?.snapshot;
}

export function cancelAnswerModal(): string | undefined {
	const state = getState();
	if (!state.handle) return undefined;
	if (!state.cancel) throw new Error("The active answer dialog cannot be cancelled by a command.");
	const snapshot = state.snapshot?.();
	state.cancel();
	return snapshot;
}

export function suspendAnswerModal(handle: OverlayHandle | undefined): boolean {
	if (!handle) return false;
	const state = getState();
	state.handle = handle;
	state.suspended = true;
	handle.setHidden(true);
	return true;
}

export function resumeAnswerModal(): boolean {
	const state = getState();
	if (!state.handle || !state.suspended) return false;
	state.handle.setHidden(false);
	state.handle.focus();
	state.suspended = false;
	return true;
}

export function clearAnswerModal(handle: OverlayHandle | undefined): void {
	const state = getState();
	if (state.handle !== handle) return;
	state.handle = undefined;
	state.suspended = false;
	state.cancel = undefined;
	state.snapshot = undefined;
}
