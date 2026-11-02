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
- `extensions/teach-learning-tools.ts` — project-local free-response, attempt-recording, vault concept search/registration, evidence-backed mastery sync, and preview-gated concept merges. Concept candidates are ranked across IDs, canonical names, definitions, aliases, subject paths, and notes, but are suggestions only. Exact ID matches continue to sync automatically. New graded evidence is stored as compact events in the vault-root `mastery-evidence.json`; scalar Obsidian mastery properties are replayed projections. A `mastery-concepts.json` catalogue holds canonical IDs and subject metadata. Concept merges require replayable evidence, a fresh preview token, and explicit learner approval; legacy aggregate-only records are not mergeable. Scores remain withheld until three distinct graded responses, then use a 0–10 weighted-evidence estimate. Their `teach_*` names avoid collisions with globally installed learning tools.
- `extensions/generator-slots.ts` — one global concurrency limit for every generator subagent (`breeze-tts-maker`, `comfyui-image-maker`, `mermaid-maker`, `svg-maker`). TTS and ComfyUI both saturate the GPU, so a burst of requests used to freeze the machine. Generator dispatches now queue instead of all starting at once; the limit defaults to 2 and is overridable with `PI_GENERATOR_CONCURRENCY` (clamped 1–8). `/generator-slots` reports current usage. A slot is released when the job completes, fails, or is dispatched in the foreground, with a 20-minute backstop.
- `extensions/teach-visual.ts` — the main agent's only diagram tool, and the mermaid/svg counterpart of `teach_comfyui_paint`. It takes a `kind` (`mermaid` or `svg`), a plain-language `brief`, a `captionTitle`, a `caption`, and an exact note anchor; it inserts a `%%pi-visual:<kind>:<id>%%` marker there and dispatches the matching maker in the background. A runtime guard blocks direct `Agent` launches of both makers. The maker publishes its PNG and calls `teach_attach_generated_visual`, which validates the file is inside its own `001-Attachments` folder and replaces the marker with a captioned embed — the same placeholder-then-link contract images and audio use.
- `extensions/teach-comfyui-paint.ts` — the main agent's only ComfyUI tool. It accepts a plain-language `prompt`, a descriptive `captionTitle`, an explanatory `caption`, and an exact note anchor chosen by the main agent; it inserts a `%%pi-comfyui-image:<id>%%` marker there and dispatches the image-maker through the global `Agent` tool in the background. A runtime guard blocks direct `Agent` launches of the image-maker so they cannot bypass marker setup.
- `agents/extensions/comfyui-image.ts` and `agents/extensions/teach-image-attachment.ts` — isolated to the `comfyui-image-maker` subagent. It refines the prompt into a fixed MOSS API call, then duplicates the descriptively named output into `001-Attachments/~comfyui` (creating the folders when absent) and replaces the exact note marker with a titled quote callout containing the italicized, quoted caption, followed by a standard Obsidian embed such as `![[001-Attachments/~comfyui/image.png]]`.
- `extensions/teach-breeze-tts.ts` and `agents/extensions/breeze-tts.ts` — the main agent owns Breeze TTS markers, retries, WAV validation, attachment placement, and note replacement; the isolated subagent generates and stages the WAV and returns its exact spoken transcript. The teacher anchors narration to exact logged concept text; the linked note's `breeze-voice-preset` frontmatter property selects either standard Breeze voice design or a random matching six-digit WAV and `{id}-transcript.txt` clone pair. Audio is placed under `001-Attachments/~breezetts` with a unique filename containing the clone name (when used) and an exactly five-word narration description; a collapsed quote callout containing the spoken transcript is placed below the embed.
- `breeze-voices.json` and `scripts/breeze_voice_presets.py` — a versioned voice-clone manifest and standalone Tkinter editor for adding, editing, removing, and validating named WAV/transcript folder pairs. Before the first Breeze request for a linked note without a valid `breeze-voice-preset` property, the user selects a clone preset or the built-in standard non-clone voice. The selected preset's human-readable `name` is stored in that note's frontmatter and resolved back to the matching configured preset on later sessions; the built-in choice is stored as `Standard Breeze voice`. Use the preset's **Build / edit…** button to create `style-instructions.json` from quick voice, delivery, pace, emotion, and pronunciation fields; the file is loaded into that preset and supplied as voice-delivery guidance.
- `scripts/configure_paths.py` and `/configure-paths` — open the Tkinter local-path settings UI for the audio.cpp and optional CUDA root folders, the default Breeze clone folders, and the md-log demo output. Machine-specific settings are stored in the ignored `local-paths.json`; use the clickable [Windows configuration shortcut](scripts/configure-paths.cmd) or run `/configure-paths` in Pi.
- `agents/breeze-tts-maker.md` — reframes one logged teaching point as expressive narration with parenthetical delivery cues and generates a staged WAV; it does not edit notes or place attachments.
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

The Breeze TTS command wrapper is `scripts/breeze-tts.cmd` and reads its audio.cpp and optional CUDA locations from `local-paths.json`. It accepts `clon` for reference-voice cloning and `tts` for the standard non-clone voice design path. Configure local paths with `/configure-paths`; use `python scripts\breeze_voice_presets.py` to add or edit additional named voice presets in `breeze-voices.json`. Each clone preset uses six-digit WAV IDs paired with exact `<id>-transcript.txt` filenames.

## Notes

You can run the system without subagents. The main session does the teaching. You just lose the researcher (truth verification) and the generated visuals.

The teaching skill is written for one learner (me). Edit the skill to fit how you learn best.

In Pi, invoke these skills explicitly with `/skill:teach` or `/skill:visualize`. Project settings enable skill commands so they appear in slash-command discovery.

At session start, md-log reports whether the session is linked and to which note. If no note is linked, it checks Termy's active Obsidian file; an empty Markdown note or one containing both md-log transcript markers triggers a Yes/No/Other prompt. Other lets you choose a different existing Markdown note. Declining keeps that session unlinked and shows the active note in the status reminder. An explicit prior `/md-unlog` suppresses the prompt when resuming that session; `/new` and `/fork` check afresh.

After restarting Pi into a saved session, use `/resume-agent` to ask the agent to continue from its most recent unfinished task without adding a user message or instructional prose to the note.

When `/md-log` links a note, it scans the current vault for exact matching mastery concept IDs, adds reciprocal `related` wikilinks, and sends a compact concept-ID preview plus mastery records from matching notes as agent context. Use `teach_find_mastery_concepts` to see ranked suggestions from IDs, canonical names, definitions, aliases, subject paths, and note paths alongside the exact-ID records. Suggestions never trigger an automatic match: verify the learning goal and scope before reusing an ID. Register new concepts—or existing uncatalogued IDs—with `teach_register_mastery_concept`; entries include a canonical name, broad-to-specific subject path, definition, true aliases, and optional parent ID. The catalogue is created lazily in the vault root.

New attempts are recorded in vault-root `mastery-evidence.json` as unique, compact evidence events and replayed deterministically; they store scores, confidence, outcome/type, interaction ID, timestamp, and optional reasoning summary, not raw answers. Per-note mastery frontmatter is a projection of this event history. On first new evidence for a legacy concept, the previous aggregate is preserved as an opaque baseline; it cannot be merged with other concepts because its original samples are unavailable. To consolidate two registered concepts, first establish that their goals are equivalent, call `teach_preview_mastery_merge`, present the affected notes, evidence counts, resulting record, and any blockers, then ask for explicit approval. Only after approval call `teach_merge_mastery_concepts` with the exact preview token. A stale preview, conflicting duplicate interaction, or legacy baseline blocks the merge without rewriting notes. The old concept ID remains in the catalogue as a redirect and its source name/aliases become aliases of the canonical entry.

## Transcript output and checks

Use `/md-section-start [prefix:] <3-6 word summary title>` and `/md-section-end` to group a teaching section under an H1; the default prefix is `Teaching`. Existing `/quiz-start [title]` and `/quiz-end` commands still group quiz rounds and surrounding conversation. Quiz and question tools can provide `summaryTitle` values to add concise labels to their H2 headings. Each quiz question gets a fenced scratchpad block in the linked note; the optional note field in the quiz UI appends to any existing text there, and the combined reasoning is returned with the quiz result to inform the next teaching question. `teach_free_response` records the learner's response under a question-specific 3–5 word H2. `teach_record_attempt` records outcome, evidence score, inferred confidence, and concept mastery. Mastery is stored as individual scalar Obsidian properties (for example, `mastery__bird-digestive-tract-order__evidence-count`) rather than a nested object, so the Properties view can display and edit each value cleanly. All unrelated frontmatter and authored note content are preserved. Scores stay hidden until three distinct graded questions are recorded for a concept, then appear on a 0–10 scale with confidence only lightly adjusting evidence weight. These entries are backfilled from the session history. After a quiz is answered, the correct option is marked `==🟢...==`; an incorrectly selected option is marked `~~==🔴...==~~`. Other tutoring emphasis follows the semantic color guide in `skills/teach/SKILL.md` and uses Obsidian 1.14+ highlight syntax.

Generated md-log headings use normalized Title Case with spaces in place of hyphens and underscores; authored headings are left unchanged.
Standalone assistant acknowledgments and common image/job progress updates are omitted from the managed transcript; explanatory lesson content continues to be recorded.
Quiz and question dialogs can be paused with F6 without losing selections or typed answers. Run `/answer-resume` after your interlude command to restore the dialog. If you also want Pi Interlude to stash the main editor draft, press F6 again after pausing the dialog; for slash commands that don't auto-restore the stash, press F6 again to restore the editor draft before entering `/answer-resume`. Commands that end or replace the session (such as `/quit`) cannot resume the pending dialog.

The quiz and question dialogs are bottom-anchored overlays so terminal output remains above them. Use `/end-lesson` to have the agent stop teaching and save a hidden resume-state comment at the end of the linked md-log note. The teach skill and md-log use the latest `pi-end-lesson` marker to resume from that point, including an unanswered quiz or question.

SVG maker renders are published under `001-Attachments/~svg`; Mermaid maker images under `001-Attachments/~mermaid`; and ComfyUI images under `001-Attachments/~comfyui`.

Linking pulls the managed section above any prose that precedes it, so authored paragraphs above the markers become addressable anchors and render once inside the section instead of twice. Embeds and transcript callouts already in the note are dropped from the import when a placement re-emits them, so re-linking does not duplicate media. Every inserted transcript callout is followed by a blank line, otherwise the next block would continue its blockquote.

Placement inside the managed section is owned by the renderer alone. The `teach_breeze_tts`, `teach_comfyui_paint`, and `teach_visual` tools record a placement entry and drop a marker into the note only as an immediate visual cue; every sync re-renders the section from the transcript, so the renderer's position always wins. An anchor resolves to the first transcript block containing it, which makes prose the user wrote above the managed markers addressable too — that prose is imported once on link and split into paragraph blocks. Session position is the fallback when an anchor has since disappeared, and an unresolvable placement is appended rather than dropped.

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
