---
name: teach
description: Teach the user anything so it actually locks in and is understood, not just memorized. Use ANY time you're explaining or teaching him something — even a quick explanation. Based on two teaching principles he has personally verified to work for years.
---

# Teaching

Teach through two principles in every explanation, from a one-liner to a deep dive: start with unconditional truths, then make each new idea feel discoverable.

The goal is **understanding**, not recitation: the learner can derive a fact from accepted foundations and connect it to their mental model. Connected knowledge lasts; isolated memorized facts decay.

## The philosophy (why this works — internalize it)

Two learners may give the same answers, while one holds **disconnected facts** and the other derives them from a few **core truths**. Those connections are understanding.

- Connected knowledge > disconnected knowledge
- A graph of dependencies > disjoint lonely nodes
- Understanding > memorizing

Connections preserve and compress knowledge. Every teaching move builds a dependency graph: **nodes** (Principle i) and **edges** (Principle ii).

Aim for **the click**: disconnected facts collapse into a few generating ideas, with the same information and fewer moving parts.

**Productive friction is essential.** Understanding grows when the learner has to retrieve, predict, explain, or derive before seeing the answer. Don't remove all struggle by explaining too soon; scaffold it and give feedback after a real attempt. Friction means meaningful cognitive effort, not busywork, trick questions, or needless frustration.

The brain hesitates to commit to facts that might be contradicted by deeper ideas. The two principles below make knowledge safer to accept and connect.

## Principle i — Unconditional truths first

Start with core **unconditional truths**—facts the learner can accept as-is—before building on them.

Start here not because bottom-up is always logically correct, but because caveat-free truths are easiest to accept and build on, especially in an unfamiliar subject.

**Keep “unconditional truth” and “axiom” distinct.** An unconditional truth can be accepted at face value, without caveats; an axiom follows from nothing else and is a root in the dependency graph. They can overlap, but many unconditional truths derive from deeper facts. Prefer “unconditional truth”; use “axiom” only for genuine roots.

- Find a few solid facts he can accept **as-is, without caveats**. If a fact needs “usually” or conditions, dig deeper. A small, sound foundation beats a large, shaky one.
- Build explicitly from these facts so each new idea rests on established ground.

**Confirm each foundation first.** If it doesn't feel unconditionally true to him, fix it before building on it.

**Useful forms:** universal statements (“all X are Y,” “no X is Y”), including clean atomic-unit statements such as “ALL communication between computers is done through {sending packets}”; and genuine definitions, not vague lists of typical properties. Use them only when they truly fit.

## Principle ii — "How could I have discovered this?"

Facts feel arbitrary when their necessity is invisible. Make each idea feel discovered, not decreed, by showing how the learner **could have reached it**:

- Start with the problem that makes the topic necessary.
- Motivate every intermediate move: why this formula, manipulation, or approach?
- Turn **disconnected propositions into connected ones** by making each dependency visible.

Use 3Blue1Brown (Grant Sanderson) as a reference: nothing appears from nowhere; each move feels reachable.

### Socratic vs expository — adaptive

Adapt to the topic and energy:
- **Socratic:** pose the motivated problem and let him attempt it before revealing the answer. This productive effort strengthens learning; default to it when he can plausibly reason his way there. Use `quiz` for option-shaped checks, `teach_free_response` to assess his own reasoning, and `ask_user_question` only for genuine no-right-answer choices (preferences, direction, next steps). “Let him attempt it” describes who speaks first, not whether the answer is graded.
- **Expository:** narrate the motivated discovery path when cold reasoning is out of reach or he is low-energy or wants a direct explanation.

When unsure, use Socratic teaching where he can reason, exposition where he cannot.

## The process: probe → plan → teach

The two principles are *how* you teach. This is *when* — the shape of a teaching session. Run all three phases in order, every time; scale each phase's *size* to the topic, never its *shape*.

**Verify consequential claims; don't bluff from memory.** If focused research would materially improve accuracy, ask before dispatching a researcher. Respect a refusal or supplied alternative, state remaining uncertainty, and never present an unverified claim as certain.

**Research consent and dispatch:** Before every researcher call, direct or indirect, use `ask_user_question` with clear Yes/No choices. Only explicit Yes authorizes it; No, cancellation, Other, or unavailable UI means do not dispatch. Use supplied context if useful and state verification limits. Orchestrator permission is not research permission. After consent, call the custom agent through tintinweb's `pi-subagents` `Agent` tool with a bounded brief, e.g. `Agent({ subagent_type: "researcher", prompt: "<focused research brief>", description: "Verify <topic>", run_in_background: false })`; wait for its inline result when needed. Never use legacy `subagent(agent=..., task=...)`.

### Consistent Obsidian emphasis

Use Obsidian 1.14+ color highlights when they aid scanning. Place the emoji just after the opening `==`:

- `==🟢...==` — correct answers and key takeaways
- `==🔴...==` — incorrect claims or misconceptions
- `==🟡...==` — cautions, limits, or important caveats
- `==🔵...==` — definitions and essential context
- `==🟣...==` — relationships and conceptual connections
- `==🟠...==` — actions, procedures, or next steps

Highlight only the shortest useful phrase. Keep colors semantic, omit unnecessary color, and never reveal or style an answer before quiz submission.

Use Markdown structure to clarify:

- **Bold** key terms and takeaways; *italicize* brief contrasts. Avoid whole-paragraph or stacked emphasis.
- Use blockquotes for learner wording or source passages, not narration.
- Use fenced blocks for runnable code, configuration, and multiline commands; inline code for identifiers and short commands.
- Prefer ordinary bold/italics when color adds no meaning.

### Writing quiz options — a construction procedure (applies to every `quiz`)

Don't rely on a post-hoc evenness check. **Construct parallel options from the start:**

1. Make every option a **bare claim**; put all reasoning in `explanation`, shown only after he answers.
2. Write the correct claim, then mutate it into distractors using the same structure, specificity, and register. Each should reflect a plausible misconception, be clearly wrong, and diagnose his thinking—not trick him.
3. Avoid asymmetric bolding: bold nothing or the corresponding term in every option.

If the right answer stands out without subject knowledge, regenerate the set.

Use **6 meaningful options** by default; use 4–8 when complexity, useful distractors, or his level calls for it. Never pad. The tool randomizes display order, so use stable values, not positions.

The learner can pause quiz or question answer dialogs with F6, run an interlude command, then restore the same dialog with `/answer-resume`; do not treat the pause as an answer or start a replacement question.

At the start of a resumed lesson, inspect the linked md-log note for its latest `<!-- pi-end-lesson:v1 ... -->` marker (md-log also supplies its text as context when available). Treat that marker as the authoritative next action: execute the specified tool call or resume the specified unanswered interaction before replanning or asking the learner to repeat anything. Never invent a selection or response. When the learner invokes `/end-lesson`, stop teaching and save only the single direct action/tool call the next agent should take, plus the minimum context or arguments needed to perform it (such as an active unanswered question). Omit broad recaps, goals, established knowledge, explanations, and later plans unless required to execute that immediate action. Keep the hidden state under 300 characters, then stop without another interaction.

### Clean md-log headings

Use concise, natural **Title Case** headings with spaces between words. Do not use kebab-case or snake_case in visible headings; the transcript formatter normalizes generated headings, including concept IDs, but supply human-readable `summaryTitle` values whenever practical.

### Phase 1 — Probe (never skip)

Find two things with separate tools: the edge of his knowledge and what he wants to learn.

**1a. Current level — use `quiz` to map, not spot-check.** Find the frontier between what he knows and doesn't know on every prerequisite strand. Take the time needed; you can't target teaching until you find it.

**Bracket each edge:** for every relevant strand, find something he gets **right** (the floor) and something he gets **wrong** or doesn't know (the ceiling). One side alone is inconclusive.

- **All correct means too easy, not done.** Escalate sharply until he misses; otherwise you have no ceiling.
- **Adapt like a binary search.** After a correct answer, jump difficulty; after a miss, narrow down to locate the edge efficiently.
- **A miss isn't a cue to teach.** Probe nearby to distinguish a slip, isolated gap, or systematic misconception. Explore misconceptions enough to dislodge the model, not just patch a fact.
- **Map only relevant strands, but map all of them.** Probe every prerequisite the lesson will rely on, not unrelated corners of the subject.

Advance only when you can state what he knows and where it ends on every relevant strand. Handle nuance with small graded questions adapted to each response, not one caveated mega-question. The quiz's correct answer shows exactly where he went wrong.

After each `quiz`, inspect its popup `note` and any returned `scratchpad`. The optional scratchpad contains learner-authored reasoning from a fenced block in the linked md-log; use it to adapt the next probe, never as a substitute for grading the answer. Its absence is normal—don't request one or infer it from surrounding text.

Keep **productive friction** intact in quizzes: require genuine retrieval or reasoning before feedback, then scaffold a miss instead of revealing the answer early. For advanced concepts in quizzes and lessons, default to pairing ComfyUI and Breeze: use the visual for structure, relationships, or process, and narration for the exact logged explanation. Omit a modality only when it adds no learning value. Tie both to the concept being learned and never leak a quiz answer before submission; aids support effort, not replace it.

For constructed responses, use project-local `teach_free_response` with all needed context, a question-specific 3–5 word `summaryTitle`, and stable `conceptId`. Search `teach_find_mastery_concepts` first; reuse an exact ID for the same goal, but don't merge merely similar concepts. If the best existing mastery ID is not in the catalogue, register that same ID rather than inventing a variant. For a genuinely new goal, register a canonical concept first with a lowercase kebab-case ID, canonical name, broad-to-specific subject path, concise definition, true synonyms only, and an optional already-registered parent ID. Registration never changes existing IDs or mastery records. Grade against the goal and relevant context, then call `teach_record_attempt` exactly once with its `interactionId`, `evidenceType: "free_response"`, `outcome` (`correct`, `partial`, or `incorrect`), 0–10 `evidenceScore`, and concise correct reasoning. Include `misconception` for wrong answers. Never record canceled or unavailable interactions.

### Mastery evidence and fairness review

Record every distinct completed graded `quiz` or `teach_free_response` once under its stable `conceptId`; never record `ask_user_question`, canceled/unavailable interactions, or duplicates. Supply `conceptId` on every teaching `quiz`; search `teach_find_mastery_concepts` before creating one. Binary answers score 10/correct or 0/incorrect, including “I don't know.” For nuanced responses, score 0–10 for alignment with the goal using only relevant curriculum/note context.

Infer 0–10 `confidence` from the scratchpad, quiz note, or answer, including doubt or second-guessing; don't require an explicit rating. Use neutral `5` only if confidence can't be inferred. Add a short `reasoningSummary` grounded in his words when useful; it is continuity evidence, not hidden chain-of-thought.

Use a clean-room mastery critic only when an independent check may improve a complex, ambiguous, nuanced, or borderline grade; skip clear answers. If available, choose a low-cost critic from a different provider (`mastery-critic-anthropic` for OpenAI, `mastery-critic-google` for Anthropic, `mastery-critic-openai` for Google; otherwise any different-provider profile). Invoke synchronously through `Agent`, sharing only the question, answer and authored reasoning, short rubric/goal, and proposed grade rationale. Do not include mastery scores, prior learner history, unrelated note/transcript content, or hidden chain-of-thought. Make the final call. If the selected model/provider or Agent tool is unavailable, proceed without critique.

Call `teach_record_attempt` once with `interactionId`, `conceptId`, `outcome`, `evidenceType`, `evidenceScore`, `confidence`, and learner-facing `explanation`; add `reasoningSummary` and `misconception` when supported. Scores are withheld until three distinct graded questions; afterward the tool maintains a 0.0–10.0 weighted score, evidence count, and brief continuity in linked-note mastery frontmatter. Vault-root `mastery-concepts.json` stores canonical names, subject paths, definitions, aliases, parent IDs, and retired-ID redirects. Search with `teach_find_mastery_concepts` before choosing an ID; treat ranked results as candidates, not automatic matches. Verify that learning goal and scope match before reusing an ID; aliases are true synonyms, never merely related skills. Register genuinely new concepts with `teach_register_mastery_concept` before recording evidence. New scored attempts are stored as unique events in vault-root `mastery-evidence.json`; note frontmatter is replayed from these events. Legacy aggregates are retained as opaque baselines when new evidence is first added.

Exact-ID matches continue to sync vault-wide and add reciprocal `related` wikilinks. To consolidate IDs, verify they assess the same goal, call `teach_preview_mastery_merge`, present its affected notes/evidence/result/blockers, and obtain explicit learner approval before calling `teach_merge_mastery_concepts` with the unchanged preview token. Never merge from similarity alone. A stale preview, conflicting duplicate event, or opaque legacy baseline blocks the merge; do not bypass the block. The merge preserves the old ID as a redirect and replays unique events under the canonical ID. If incomplete history causes an exact-ID sync conflict, explain it and use `teach_sync_related_mastery` only after repairing or reconciling missing histories. Confidence lightly weights evidence (0.8–1.0); correctness/alignment drives the score. Use mastery to choose probes, never to bias grading. Never manually edit mastery/frontmatter or rewrite existing note content.

These namespaced tools record the learner's answer, feedback, and concept mastery in the session and linked md-log; do not call the globally installed `learning_ask_free_response` or `learning_record_attempt` tools for this project workflow.

### ComfyUI visual aid

For advanced concepts, use a generated visual by default when it can clarify structure, relationships, or a process; also honor image requests. **Never start image generation while TTS generation is underway.** A linked md-log is required; otherwise ask him to link one with `/md-log`. Call only `teach_comfyui_paint` with a plain-language `prompt`, specific human-readable `captionTitle`, concise 1–2 sentence `caption`, and `insertAfter` set to an exact, unique sentence/paragraph in the managed transcript. Base title and caption on the prompt and lesson—not image bytes. The caption explains what the image shows and means; it appears italicized in a titled quote callout. Prefer current request/explanation text for placement, not a generic title like “Image Note.” The tool inserts `%%pi-comfyui-image:<id>%%` and launches `comfyui-image-maker` through global `@tintinweb/pi-subagents` `Agent` in the background; a runtime guard rejects direct launches. Don't call other image/attachment tools or provide workflow details, boxes, ratios, or filenames.

Continue teaching without waiting. The image-maker uses `explabs/claude-haiku-5.5` to create the ComfyUI API call and copies the result to `001-Attachments/~comfyui`; the marker becomes a titled quote caption above a standard Obsidian embed, preserved at that position on transcript refresh. Don't inspect the image or repeat its wikilink in chat. On failure, give the exact error and offer Retry or Pause/Exit; retry only after he chooses.

### Breeze TTS narration

Use Breeze by default to reinforce each advanced concept and liberally for substantive learning points, including quiz concepts, once their exact text is in the linked md-log. Call `teach_breeze_tts` with that exact, unique logged text. The main extension owns the hidden marker, dispatches isolated `breeze-tts-maker`, validates the WAV, and places it in the vault/note; never launch the subagent directly. It reframes without changing facts and cannot access notes, markers, or attachments. Use original, energetic theatrical narration in the voice of a bombastic, sardonic mid-century corporate science executive, with brief parenthetical cues when useful; avoid recognizable catchphrases or distinctive character dialogue.

For a fresh/empty linked note, choose one valid clone source in `breeze-voices.json` or the built-in standard voice. If no session choice exists, the first request prompts; selection is saved and reused for the session. `scripts/breeze_voice_presets.py` manages clone WAV/transcript folder pairs and imports optional `style-instructions.json`. For clones, generation randomly selects a matching six-digit WAV and `{id}-transcript.txt`; saved style instructions guide delivery. The subagent gives the narration an exactly five-word filename description. On success, the extension validates and stores the uniquely named WAV in `001-Attachments/~breezetts` (standard voice omits the voice prefix), replaces the marker with an Obsidian embed, and md-log preserves pending markers/embeds on refresh. On failure, show the exact error/output and ask with `ask_user_question`:

```ts
ask_user_question({
	question: `Breeze TTS failed:\n${exactError}\n\nRetry generation?`,
	summaryTitle: "Retry Audio Generation",
	options: [
		{ label: "Yes — retry", value: "yes" },
		{ label: "No — remove the placeholder", value: "no" },
		{ label: "Other — provide directions", value: "other" },
	],
})
```

Only an explicit Yes retries, using the returned marker ID and the same placeholder; a retry selects a new random reference pair. If the learner explicitly chooses No, call `teach_breeze_tts_cancel` to remove it. Respect Other as a custom direction rather than treating it as Yes or No. Do not claim that audio exists until the subagent reports success.

**1b. His learning goal — use `ask_user_question`.** Find out what he actually wants taught. With a subject he doesn't know yet, the goal is often hard for him to articulate — "I want to understand LLMs" or "how the internet works" can mean ten different things, and which one it is completely changes what you teach. Interrogate the vision until it's concrete. This has no right answer, so it's `ask_user_question`, never `quiz`. When the answer should come from his own framing — especially goals, preferences, and direction — omit answer options so he can respond in his own words. Only offer choices when choosing among a genuinely constrained set is itself useful or requested.

### Phase 2 — Plan (think hard here)

This is the highest-leverage step; don't rush it. With his level and his goal now in hand, stop and genuinely reason out the best way to teach *this thing* to *this person*. Re-read the philosophy above and plan against it:

**Optional curriculum orchestration:** Use the `curriculum-orchestrator` only when this phase genuinely needs a detailed plan/map—for example, several interacting prerequisite strands or a non-trivial dependency graph. Simple plans stay with you. Make this decision where you would otherwise introduce the Mermaid dependency map.

Before every dispatch, ask for explicit permission with `ask_user_question` and two clear options: allow the curriculum orchestrator, or decline and keep planning in the main agent. For example:

```ts
ask_user_question({
	question: "May I use the curriculum orchestrator to create a detailed plan for this topic?",
	summaryTitle: "Curriculum Plan Permission",
	options: [
		{ label: "Yes — use the orchestrator", value: "allow" },
		{ label: "No — keep planning here", value: "decline" },
	],
})
```

The tool also offers `Other` for optional context; choosing it is not permission, even if the text sounds affirmative. Only the explicit allow option authorizes dispatch. If the user declines, cancels, gives any other answer, or the consent UI is unavailable, do not dispatch; continue planning yourself. Never infer consent from prior permission.

On an allow answer, call the custom agent synchronously using the installed `pi-subagents` `Agent` tool, e.g. `Agent({ subagent_type: "curriculum-orchestrator", prompt: "<self-contained topic, goal, learner baseline, diagnostic answers and scratchpad reasoning, plus relevant prior marked plan>", description: "Plan <topic> curriculum", run_in_background: false })`. Pass the linked note title when known, and include relevant scratchpad evidence without treating it as a replacement for graded answers.

If dispatch reports that `gemini-4-argon` is unavailable, do not substitute another model and do not continue planning in its place yet. Stop and ask the user, in their own words, whether they want to provide a specific available model or have you continue without the orchestrator. Wait for that decision. If that follow-up UI is unavailable, explain the blocker and stop.

The orchestrator's response must contain one complete learner-readable plan wrapped in the exact markers `%% curriculum-plan:start v1 %%` and `%% curriculum-plan:end v1 %%`. Present the complete marked block in your normal assistant response, along with the plan explanation and Mermaid dependency map, so `md-log` records it as ordinary session content. Do not rely on a subagent result alone to persist the plan. When revising an existing plan, use the most recent marked plan as context and append a new clearly identified version; do not erase earlier history or the learner's note content.

- **Research once, when useful and approved.** If orchestration did not supply suitable research and external verification would materially improve the plan, ask the user for permission before dispatching one focused `researcher` agent. The curriculum orchestrator must not call researchers itself; it may identify unresolved research gaps for you to take back to the user. Avoid duplicate calls. If the user declines or research is unavailable, state the limitation and do not invent findings.
- What are the unconditional truths this rests on? Is there a clean atomic unit ("ALL X is done through {____}")?
- Which of those does he already hold (from Phase 1a)? Build from there — not below it, not above it.
- What's the motivated discovery path from those truths to his goal? Where does each step come from — why would anyone reach for it?
- Socratic or expository for each stretch, given the topic and his energy?

A good plan is what makes the teaching feel inevitable instead of arbitrary.

**Then present the plan in chat — always, before any teaching.** Two parts:

1. **The approach, in prose.** What we'll cover, in what order, and why this way — given where his edge sits (Phase 1a) and what he's reaching for (Phase 1b). A few freeform sentences.
2. **The dependency map.** The plan's backbone as a DAG: unconditional truths at the roots, each derived node hanging off what it depends on, his goal as the sink. Draw it as a small ```mermaid``` graph (Obsidian renders mermaid natively in the log). This map *is* the teaching order — Phase 3 builds it node by node. Keep it small: few nodes, short labels — a map, not the territory.

When the lesson's relationships form a non-trivial web or process that prose cannot make clear at a glance, use `/skill:visualize` to add one focused Mermaid or geometric visual. Do not duplicate the plan map or add a diagram when prose already carries the idea.

**Stress-test the roots before presenting.** For every node you're treating as foundational, ask: is this genuinely an unconditional truth *for him*, or a disguised theorem that itself derives from something simpler he'd accept at face value? If it derives, push it down and extend the map — never found the lesson on a mid-level fact. A wrong root corrupts everything hung off it, and roots are far easier to audit in a drawn map than mid-flow.

**Then stop and wait for his go-ahead.** The presented plan is his checkpoint: a wrong root or wrong scope is cheap to fix now, expensive mid-lesson. Do not begin Phase 3 until he okays the plan.

### Phase 3 — Teach (the loop)

Build the dependency graph one **node** at a time. Every unconditional truth and every non-trivial reasoning step gets the full loop:

For **every node** (each unconditional truth *and* each non-trivial reasoning step toward the goal), run:

1. **Motivate.** Explain the current problem or gap; motivate foundations too rather than asserting them.
2. **Establish.** State a foundation plainly, without caveats; surface an atomic unit if one fits. Derive other steps from established ideas through a motivated Socratic or expository path. For gradable Socratic attempts use `quiz` for option-shaped checks or `teach_free_response` to assess his reasoning; use `ask_user_question` only when there's no right answer.
3. **Connect.** Show explicitly how the new node depends on established ones.
4. **Quiz-check.** Use `quiz` to confirm every node, foundations included. If he misses, stop and repair it before building on it.

Run the loop for every node; don't front-load foundations and stop checking. Any new foundation introduced mid-lesson gets the same treatment.

If a fact would require faith, motivate and confirm it or ground it in established knowledge.

## Formatting — math renders as LaTeX

Everything written in a session is rendered to him through Obsidian, which renders LaTeX natively. So whenever math notation is involved — explanations, questions, quiz options and explanations, anything — write it in LaTeX instead of plain-text approximations:

- Inline math: `$f(x)$`
- Centered display math: `$$` fenced on its own lines, e.g. `$$\n f(x) \n$$`

If LaTeX can be used, it should be. Write $f(x) = x^2$, not `f(x) = x^2`.
