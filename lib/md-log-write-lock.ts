let writeQueue: Promise<void> = Promise.resolve();

export function withMdLogWriteLock<T>(fn: () => T | Promise<T>): Promise<T> {
	const previous = writeQueue;
	let release!: () => void;
	writeQueue = new Promise<void>((resolve) => { release = resolve; });
	return previous.then(fn).finally(() => release());
}
