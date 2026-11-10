# Pi tool-access policy

This project uses explicit per-agent capabilities. A tool is granted only when it directly supports that agent's assigned work. Skills and prompt instructions do not grant access.

## Enforcement

- Project `settings.json` removes Pi's built-in `bash` tool from the main session with `defaultTools: ["-bash"]`.
- Every custom agent declares `disallowed_tools: bash` and an explicit tool/extension scope. The three mastery critics additionally disable extensions, skills, and inherited conversation context.
- Default subagents are disabled and `fallbackSubagent: "none"` rejects unknown agent types instead of substituting a broad general-purpose agent.
- Scripted `SubagentWorkflow` is disabled because its `gate` option can run a shell command; the teaching flow uses named `Agent` delegations instead.
- `pi-json-tools` is filtered out for this project: it can execute model-generated Bash internally and is not the local JSON reader.
- The locally authored `read_json_data` tool is a global extension at `~/.pi/agent/extensions/read-json-data.ts`; any agent granted this tool must also be granted `csv_query`.

## Capability map

| Agent | Granted capabilities |
|---|---|
| Main teacher | Pi built-ins `read`, `edit`, and `write`; project teaching tools; enabled web, YouTube, CSV, JSON, FFF search, and Pi Defender tools; named subagent orchestration |
| researcher | Web search, source checking, fetch and stored search content; YouTube transcripts; bounded CSV and JSON queries |
| curriculum-orchestrator | Bounded CSV and JSON queries; may delegate only to `researcher` when external research is authorized |
| mastery critics | No tools, extensions, skills, or inherited conversation |
| breeze-tts-maker | Breeze generation handoff tool only |
| comfyui-image-maker | ComfyUI generation/status and image-placement tools only |
| mermaid-maker | Mermaid author/edit/render and visual-placement tools only |
| svg-maker | SVG author/edit/render and visual-placement tools only |

The JSON reader returns bounded, filtered data but can read any JSON path the agent can name; do not grant it to agents that do not need local data access. The research and media extensions may perform their own network or media-processing work internally; this policy removes direct Bash tool access, not all subprocesses inside trusted tools.

`defaultTools` is a Pi startup default, not an operating-system sandbox. A manually supplied CLI `--tools` override can replace it. Start Pi from the Obsidian vault root so this project's settings, agents, and extensions are loaded. The main session receives all tools from extensions enabled for the project; Pi 1.5.0 has no main-session per-extension-tool allowlist in project settings, so its extension scope remains broader than a specialist subagent's.
