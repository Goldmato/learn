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
- `extensions/quiz/` — graded questions with instant feedback (✓/✗, correct answer, explanation)
- `extensions/md-log.ts` — link a markdown file to the session; in Termy, run `/md-log` without arguments to link the active Obsidian note. Generated transcript content is held between hidden `%% pi-md-log:start v1 %%` / `%% pi-md-log:end v1 %%` markers, and backfill preserves note text outside that section.
- `extensions/visual-tools/` — tools for visualization subagents
- `agents/` — `researcher`, `svg-maker`, `mermaid-maker`: the subagents the system delegates to

## Install

This repo **is** a `.pi` directory. From your learning project's root:

```bash
git clone https://github.com/amosblomqvist/learn .pi
```

Then open pi in that directory. (Or copy the pieces you want into your existing project config.)

## Requirements

- [pi](https://github.com/earendil-works/pi)
- [tintinweb/pi-subagents](https://github.com/tintinweb/pi-subagents), installed with `pi install npm:@tintinweb/pi-subagents`. It loads custom agent definitions from `.pi/agents/` and provides the `Agent` tool. The teaching and visualization skills invoke custom agent types with `Agent({ subagent_type: "researcher", prompt: "...", description: "...", run_in_background: false })`. The researcher uses only pi's `bash` and `read` built-ins (`extensions: false`) for read-only web requests; visual makers load only their own tool extension and selected tools via `extensions:` and `ext:` selectors.
- `ask-user-question` — use the copy bundled here. If your setup already has an `ask-user-question` extension, use **this** one in its place. Popups from different extensions serialize through a shared UI lock, which only works when it's the same implementation.

## Notes

You can run the system without subagents. The main session does the teaching. You just lose the researcher (truth verification) and the generated visuals.

The teaching skill is written for one learner (me). Edit the skill to fit how you learn best.

## Transcript output and checks

Quiz rounds are written as `## Round N` sections under `# Quiz`; use `/quiz-start [title]` and `/quiz-end` to explicitly group a run across intervening conversation. Non-graded question rounds also have H2 headings. After a quiz is answered, the correct option is marked `==🟢...==`; an incorrectly selected option is marked `~~==🔴...==~~`. Other tutoring emphasis follows the semantic color guide in `skills/teach/SKILL.md` and uses Obsidian 1.14+ highlight syntax.

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
