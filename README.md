# learn
Fork of [amosblomqvist/learn](https://github.com/amosblomqvist/learn) with Termy support for linking the active Obsidian note through `/md-log`.

Currently only compatible with the Termy Obsidian terminal plugin. Future compatibility is not planned.

[![video](assets/thumbnail.png)](https://www.youtube.com/watch?v=kzcI5F4tGiU)

My AI learning system from this video: [How I Use AI to Learn Things](https://www.youtube.com/watch?v=kzcI5F4tGiU).

This is a personal system I built for myself, shared as-is. Built as a pi configuration: the teaching philosophy encoded in a skill, a few small extensions, and agent definitions.

## What's in it

- `skills/teach/` — the philosophy and the process
- `skills/visualize/` — adds a correct, minimal diagram to a lesson when an idea is clearer as a picture
- `extensions/ask-user-question/` — the agent asks you questions through a UI popup
- `extensions/quiz.ts` — graded questions with 4–8 answer options, automatically randomized order, instant feedback (✓/✗, correct answer, explanation), and an optional linked-md-log scratchpad for learner reasoning
- `extensions/teach-learning-tools.ts` — project-local free-response, attempt-recording, vault concept-search, and related-mastery sync tools. Before choosing a concept ID, the teacher can search the current vault and reuse an exact existing ID. Exact ID matches add reciprocal `related` Obsidian links; unique recorded evidence is merged and replayed across matching notes. Ambiguous conflicts with incomplete evidence are reported without overwriting notes. Scores remain withheld until three distinct graded responses, then use a 0–10 weighted-evidence estimate. Their `teach_*` names avoid collisions with globally installed learning tools.
- `extensions/teach-comfyui-paint.ts` — the main agent's only ComfyUI tool. It accepts a plain-language `prompt`, a descriptive `captionTitle`, an explanatory `caption`, and an exact note anchor chosen by the main agent; it inserts a `%%pi-comfyui-image:<id>%%` marker there and dispatches the image-maker through the global `Agent` tool in the background. A runtime guard blocks direct `Agent` launches of the image-maker so they cannot bypass marker setup.
- `agents/extensions/comfyui-image.ts` and `agents/extensions/teach-image-attachment.ts` — isolated to the `comfyui-image-maker` subagent. It refines the prompt into a fixed MOSS API call, then duplicates the descriptively named output into `001-Attachments/~comfyui` (creating the folders when absent) and replaces the exact note marker with a titled quote callout containing the italicized, quoted caption, followed by a standard Obsidian embed such as `![[001-Attachments/~comfyui/image.png]]`.
- `extensions/teach-breeze-tts.ts` and `agents/extensions/breeze-tts.ts` — the main agent's guarded Breeze TTS dispatch and the isolated generation/attachment tool. The teacher anchors narration to exact logged concept text; the selected session preset determines whether audio.cpp uses standard Breeze voice design or a random matching six-digit WAV and `{id}-transcript.txt` clone pair. Audio is placed under `001-Attachments/~breezetts` with a unique filename containing the clone name (when used) and an exactly five-word narration description.
- `breeze-voices.json` and `scripts/breeze_voice_presets.py` — a versioned voice-clone manifest and standalone Tkinter editor for adding, editing, removing, and validating named WAV/transcript folder pairs. When an empty/fresh md-log note is linked, the user selects one clone preset or the built-in standard non-clone voice for the whole session.
- `agents/breeze-tts-maker.md` — reframes one logged teaching point as expressive narration with parenthetical delivery cues and uses the selected session voice preset.
- `extensions/csv_tools.ts` — read-only, workspace-contained CSV inspection, field filtering, sorting, aggregation, and bounded text search for the main agent; the researcher receives only this tool in addition to its existing `bash` and `read` tools. It parses and searches locally, with 10 MiB / 100,000-record input limits and at most 20 returned rows. Comma-, tab-, and semicolon-delimited files are supported; omitted trailing fields are treated as empty. Search supports Chinese, Japanese, and Korean text using character and overlapping-pair tokens. The interactive terminal renderer shows every returned field under its original header, bounded by display limits, with Pi's standard `Ctrl+O` expand/collapse behavior.
- `extensions/visual-tools/` — tools for visualization subagents
- `agents/` — `researcher`, `svg-maker`, `mermaid-maker`, `comfyui-image-maker`, three provider-specific `mastery-critic` profiles, and the consent-gated `curriculum-orchestrator`. The teacher may use a low-cost critic from a different provider when an answer is complex or ambiguous; straightforward answers are graded without one. The teacher asks the user before dispatching a researcher; the curriculum orchestrator identifies research gaps but does not dispatch researchers itself. It uses `gemini-4-argon` for detailed learning plans; the main teacher asks permission before dispatch and saves the returned marked plan in the linked md-log. The ComfyUI subagent has only fixed-workflow generation/status tools and a purpose-built vault-attachment tool; it has no general file-reading or image-reading tools. The researcher uses `curl` GET requests against Bing's HTML search endpoint, with DuckDuckGo as a fallback, and fetches source pages; outbound access still depends on the host/sandbox network and proxy configuration.

## Install

This repo **is** a `.pi` directory. From your learning project's root:

```bash
git clone https://github.com/amosblomqvist/learn .pi
```

Then open pi in that directory. (Or copy the pieces you want into your existing project config.)

## Requirements

- [pi](https://github.com/earendil-works/pi)
- [tintinweb/pi-subagents](https://github.com/tintinweb/pi-subagents), installed globally with `pi install npm:@tintinweb/pi-subagents`. It loads custom agent definitions from `.pi/agents/` and provides the `Agent` tool. The teaching and visualization skills invoke custom agent types with `Agent({ subagent_type: "researcher", prompt: "...", description: "...", run_in_background: false })`. The researcher uses pi's `bash` and `read` built-ins for read-only web research and is granted only the `csv_query` tool from the local CSV extension; visual makers load only their own tool extensions and selected tools via `extensions:` and `ext:` selectors.
- `ask-user-question` — use the copy bundled here. If your setup already has an `ask-user-question` extension, use **this** one in its place. Popups from different extensions serialize through a shared UI lock, which only works when it's the same implementation.
- `pi-comfyui-paint@0.3.0` must be available locally to the isolated image-maker extension. Do **not** register it in `.pi/settings.json` as a project-wide package: that would expose its workflow-discovery and unrestricted `paint_*` tools to the main agent.

The approved MOSS API-format workflow is `.pi/comfyui_workflows/MOSS_Image_base_T2i_BBoxes_API.json`. Its prompt and optional bounding-box variables are supplied per request; box coordinates are normalized and validated before the fixed workflow runs. The template's sample layout has been removed. Model weights are managed separately by the user. `.pi/comfyui-paint.json` pins the local endpoint and sets `inlineImageLimit` to `0`; do not override this setting because image bytes must not enter an agent context.

The Breeze TTS command wrapper is `scripts/breeze-tts.cmd`; on the configured Windows machine it is installed as `C:\Utilities\breeze-tts.cmd`, using the locally installed `audio.cpp` CLI and Q8_0 Breeze TTS 2 model. The wrapper accepts `clon` for reference-voice cloning and `tts` for the standard non-clone voice design path. Edit the named WAV/transcript sources with `python scripts\breeze_voice_presets.py`; the standalone GUI uses Tkinter (included with the configured Python installation) and writes `breeze-voices.json`. Each clone preset uses six-digit WAV IDs paired with exact `<id>-transcript.txt` filenames.

## Notes

You can run the system without subagents. The main session does the teaching. You just lose the researcher (truth verification) and the generated visuals.

The teaching skill is written for one learner (me). Edit the skill to fit how you learn best.

In Pi, invoke these skills explicitly with `/skill:teach` or `/skill:visualize`. Project settings enable skill commands so they appear in slash-command discovery.

At session start, md-log reports whether the session is linked and to which note. If no note is linked, it checks Termy's active Obsidian file; an empty Markdown note or one containing both md-log transcript markers triggers a Yes/No/Other prompt. Other lets you choose a different existing Markdown note. Declining keeps that session unlinked and shows the active note in the status reminder. An explicit prior `/md-unlog` suppresses the prompt when resuming that session; `/new` and `/fork` check afresh.

After restarting Pi into a saved session, use `/resume-agent` to ask the agent to continue from its most recent unfinished task without adding a user message or instructional prose to the note.

When `/md-log` links a note, it scans the current vault for exact matching mastery concept IDs, adds reciprocal `related` wikilinks, and sends a compact concept-ID preview plus mastery records from matching notes as agent context. Use `teach_find_mastery_concepts` to search the full vault before creating a new ID; recorded evidence is merged across matching notes automatically, while conflicts without complete evidence are reported rather than guessed.

## Transcript output and checks

Use `/md-section-start [prefix:] <3-6 word summary title>` and `/md-section-end` to group a teaching section under an H1; the default prefix is `Teaching`. Existing `/quiz-start [title]` and `/quiz-end` commands still group quiz rounds and surrounding conversation. Quiz and question tools can provide `summaryTitle` values to add concise labels to their H2 headings. Each quiz question gets a fenced scratchpad block in the linked note; the optional note field in the quiz UI appends to any existing text there, and the combined reasoning is returned with the quiz result to inform the next teaching question. `teach_free_response` records the learner's response under a question-specific 3–5 word H2. `teach_record_attempt` records outcome, evidence score, inferred confidence, and concept mastery. Mastery is stored as individual scalar Obsidian properties (for example, `mastery__bird-digestive-tract-order__evidence-count`) rather than a nested object, so the Properties view can display and edit each value cleanly. All unrelated frontmatter and authored note content are preserved. Scores stay hidden until three distinct graded questions are recorded for a concept, then appear on a 0–10 scale with confidence only lightly adjusting evidence weight. These entries are backfilled from the session history. After a quiz is answered, the correct option is marked `==🟢...==`; an incorrectly selected option is marked `~~==🔴...==~~`. Other tutoring emphasis follows the semantic color guide in `skills/teach/SKILL.md` and uses Obsidian 1.14+ highlight syntax.

Generated md-log headings use normalized Title Case with spaces in place of hyphens and underscores; authored headings are left unchanged.
Standalone assistant acknowledgments and common image/job progress updates are omitted from the managed transcript; explanatory lesson content continues to be recorded.
Quiz and question dialogs can be paused with F6 without losing selections or typed answers. Run `/answer-resume` after your interlude command to restore the dialog. If you also want Pi Interlude to stash the main editor draft, press F6 again after pausing the dialog; for slash commands that don't auto-restore the stash, press F6 again to restore the editor draft before entering `/answer-resume`. Commands that end or replace the session (such as `/quit`) cannot resume the pending dialog.

The quiz and question dialogs are bottom-anchored overlays so terminal output remains above them. Use `/end-lesson` to have the agent stop teaching and save a hidden resume-state comment at the end of the linked md-log note. The teach skill and md-log use the latest `pi-end-lesson` marker to resume from that point, including an unanswered quiz or question.

SVG maker renders are published under `001-Attachments/~svg`; Mermaid maker images under `001-Attachments/~mermaid`; and ComfyUI images under `001-Attachments/~comfyui`.

To migrate existing notes from the older nested `mastery:` map, first preview a file or vault directory:

```bash
node --experimental-strip-types scripts/migrate-mastery-frontmatter.mjs "C:\path\to\vault"
```

Add `--write` to apply the conversion. The script processes Markdown files recursively, skips Obsidian and common tooling directories, preserves other frontmatter and note content, and reports malformed notes without overwriting them.

Run the portable formatter/backfill checks and smoke test with Node.js 24 or newer:

```bash
node --experimental-strip-types --test tests/*.test.mjs
node --experimental-strip-types scripts/md-log-smoke.mjs
```

To write or refresh a representative note in the configured vault's `002-Testing` folder:

```bash
node --experimental-strip-types scripts/md-log-demo.mjs
```

Use `--output <path>` to choose another demo file. The script only updates its `pi-md-log` marked section, preserving other content.
