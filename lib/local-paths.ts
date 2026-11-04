import * as fs from "node:fs";
import * as path from "node:path";

export interface LocalPathConfig {
	audioCppRoot: string;
	cudaRootDirectory: string;
	mdLogDemoOutput: string;
	breezeVoice: {
		name: string;
		wavsDirectory: string;
		transcriptsDirectory: string;
	};
}

const EMPTY_LOCAL_PATHS: LocalPathConfig = {
	audioCppRoot: "",
	cudaRootDirectory: "",
	mdLogDemoOutput: "",
	breezeVoice: {
		name: "",
		wavsDirectory: "",
		transcriptsDirectory: "",
	},
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown, key: string): string {
	if (value === undefined) return "";
	if (typeof value !== "string") throw new Error(`Local path config field "${key}" must be a string.`);
	return value.trim();
}

export function readLocalPaths(configRoot: string): LocalPathConfig {
	const configPath = path.join(configRoot, "local-paths.json");
	let data: unknown;
	try {
		const stat = fs.lstatSync(configPath);
		if (!stat.isFile() || stat.isSymbolicLink()) {
			throw new Error(`Local path config is not a regular file: ${configPath}`);
		}
		data = JSON.parse(fs.readFileSync(configPath, "utf-8"));
	} catch (error) {
		if (isRecord(error) && error.code === "ENOENT") return structuredClone(EMPTY_LOCAL_PATHS);
		throw new Error(`Could not load local path config "${configPath}": ${error instanceof Error ? error.message : String(error)}`);
	}

	if (!isRecord(data) || data.version !== 1) {
		throw new Error(`Local path config "${configPath}" must contain version 1.`);
	}
	const voice = data.breezeVoice;
	if (voice !== undefined && !isRecord(voice)) {
		throw new Error(`Local path config "${configPath}" has an invalid breezeVoice object.`);
	}
	return {
		audioCppRoot: stringValue(data.audioCppRoot, "audioCppRoot"),
		cudaRootDirectory: stringValue(data.cudaRootDirectory, "cudaRootDirectory"),
		mdLogDemoOutput: stringValue(data.mdLogDemoOutput, "mdLogDemoOutput"),
		breezeVoice: {
			name: stringValue(voice?.name, "breezeVoice.name"),
			wavsDirectory: stringValue(voice?.wavsDirectory, "breezeVoice.wavsDirectory"),
			transcriptsDirectory: stringValue(voice?.transcriptsDirectory, "breezeVoice.transcriptsDirectory"),
		},
	};
}
