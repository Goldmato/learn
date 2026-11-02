import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { spawn } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export default function configurePaths(pi: ExtensionAPI) {
	pi.registerCommand("configure-paths", {
		description: "Open the local path settings UI",
		handler: (ctx) => {
			const extensionDirectory = path.dirname(fileURLToPath(import.meta.url));
			const scriptPath = path.resolve(extensionDirectory, "../scripts/configure_paths.py");
			const python = process.env.PI_PYTHON ?? (process.platform === "win32" ? "python" : "python3");
			const child = spawn(python, [scriptPath], {
				detached: true,
				stdio: "ignore",
				windowsHide: true,
			});
			child.once("spawn", () => {
				child.unref();
				ctx.ui.notify("Path configuration opened. Saved settings apply to future Breeze and demo runs.", "info");
			});
			child.once("error", (error) => {
				ctx.ui.notify(`Could not open path configuration with "${python}": ${errorMessage(error)}`, "error");
			});
			child.once("exit", (code) => {
				if (code !== null && code !== 0) {
					ctx.ui.notify(`Path configuration exited with code ${code}. Check that Python and Tkinter are installed.`, "error");
				}
			});
		},
	});
}
