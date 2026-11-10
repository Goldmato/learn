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

**Research consent and dispatch:** Before any direct researcher call, use `ask_user_question` with clear Yes/No choices. Only explicit Yes authorizes it; No, cancellation, Other, or unavailable UI means do not dispatch. Orchestrator permission is not research permission. For indirect research, obtain explicit research consent before invoking the curriculum orchestrator and include that consent in its brief; it may delegate only when the brief confirms consent. Each calling agent may have at most one active `researcher` subagent at a time: the main agent has its own limit of one, and the curriculum orchestrator has its own limit of one. Wait for its result before that caller starts another researcher. Use a bounded brief and call the custom agent through tintinweb's `pi-subagents` `Agent` tool, e.g. `Agent({ subagent_type: "researcher", prompt: "<focused research brief>", description: "Verify <topic>", run_in_background: false })`. Never use legacy `subagent(agent=..., task=...)`.

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

Choose 4–8 real options based on the question's complexity and the number of genuinely useful, parallel distractors. Prefer the smallest set that still distinguishes the important misconceptions; never target a fixed count or pad. The tool randomizes display order, so use stable values, not positions.

**Keep practice varied and diagnostically honest.** Before a multi-item round, identify the exact skill being assessed and choose formats that reveal it rather than repeating one convenient template. Depending on the goal, vary contextual inference, close-meaning contrast, clause/relationship interpretation, sentence repair, transfer to a new context, and constructed explanation. A multiple-choice answer tests recognition among those options; it does not establish full sentence comprehension or productive command. Do not equate an easy correct selection with broad mastery when the learner's scratchpad or translation reveals a separate error. Preserve that as an unresolved subskill and revisit it with a targeted probe. Build distractors from plausible adjacent meanings and the learner's observed confusions, not unrelated options; vary the distinction being tested while keeping the choices equally plausible in form. Repeating one format is fine when deliberate retrieval practice is the goal, not as the automatic default.

For language learning, plan the modalities separately: reading, listening, and production are distinct skills. If the learner requests listening or chooses a mixed language-practice round, include at least one useful spoken-language activity with Breeze rather than silently making the whole round reading-based. If the learner misparses a spoken-language target or identifies listening as a gap, prepare a short target-language replay before the next relevant probe. The current Breeze tool places audio in the linked note; for a genuine listening check, keep the target script, pinyin, translation, and audio transcript concealed until after the attempt. If that separation cannot be guaranteed, use speech only as post-answer reinforcement and do not label it a listening assessment.

The learner can pause quiz or question answer dialogs with F6, run an interlude command, then restore the same dialog with `/answer-resume`; do not treat the pause as an answer or start a replacement question.

At the start of a resumed lesson, read this teaching skill and use the linked md-log transcript already supplied in conversation context, together with the recent session history. `/md-log` injects the linked transcript when it is linked or restored; do not use shell, grep, find, or file-reading tools to fetch that same transcript again. `/resume-agent` supplies and consumes the latest `<!-- pi-end-lesson:v1 ... -->` marker when present; use it only to locate an explicitly pending action, not as a substitute for the transcript context. Reconcile it with the most recent completed question, learner response, feedback, and any unanswered interaction. If the handoff says the lesson ended or no interaction is pending, confirm that briefly and wait for the learner's next request. Do not treat an earlier assistant offer or teaser as a task, or start a new quiz, interview, or replacement activity just to continue teaching. Without a handoff, resume only an interaction or task that is explicitly unfinished in the injected transcript and session history. Resume the same explicitly unanswered question; a cancelled or skipped question is a learner choice, not an unanswered question, and must not be regenerated in equivalent form unless requested. Never repeat a completed question or round, or ask the learner to restate context. Never invent a selection or response. When the learner invokes `/end-lesson`, stop teaching and save only an explicitly unanswered live interaction and the minimum context or arguments needed to resume it. If no live interaction is pending, state that the lesson ended and the next agent must wait for the learner's next request. Omit broad recaps, goals, established knowledge, explanations, and inferred future plans. Keep the hidden state under 300 characters, then stop without another interaction.

When the user invokes `/rename`, review the lesson transcript and recent context, call `teach_list_vault_note_names` to inspect existing vault filename conventions, then rename only the linked log with `teach_rename_md_log`. Choose a concise, descriptive name grounded in the lesson; preserve the current folder and `.md` extension. If the topic is unclear, leave the filename unchanged and explain why.

### Clean md-log headings

Use concise, natural **Title Case** headings with spaces between words. Do not use kebab-case or snake_case in visible headings; the transcript formatter normalizes generated headings, including concept IDs, but supply human-readable `summaryTitle` values whenever practical.

### Phase 1 — Probe (never skip)

Find two things with separate tools: the edge of his knowledge and what he wants to learn.

**1a. Current level — inspect evidence before probing.** After linking the md-log, search mastery concepts and their evidence, then consider relevant interactions already recorded in this session. Judge whether that evidence is recent and representative enough to choose the next stage. If it is insufficient before a substantial new learning sequence, ask whether he wants a focused diagnostic/baseline round or would rather continue elsewhere. Do not start a diagnostic automatically when existing evidence is adequate.

**A baseline is a purpose, not a question format.** Use the existing `quiz` and `teach_free_response` forms for knowledge checks; keep a diagnostic bounded to prerequisite strands that matter to the next stage. Probe both a likely strength and a likely edge where useful, and adapt difficulty to answers. The goal is a defensible starting point, not an exhaustive interview.

**Learning-goal intake is a separate purpose, not an assessment.** In a genuinely new session that starts a new linked md-log transcript, wait for the learner's first prompt, then search the vault mastery catalogue/evidence for the requested subject before teaching or launching broader research. Use that context to shape exactly one `teach_learning_interview` call with 3–5 high-signal open-ended questions. Probe the learner's motivation, the specific aspect or tension they care about, and what they hope to understand or do; ask about background or boundaries only when useful. Ask questions that get to the heart of this request, not a fixed checklist. This modal is a single sequential interview round, not a knowledge quiz: never grade or record its answers as mastery evidence. Afterward, synthesize the goal and proceed; do not repeat session intake on resumed sessions, an existing transcript, or later turns in the same session.

After a completed quiz assessment round, `teach_learning_interview` may be used once with purpose `post-assessment` when the learner's next focus or underlying goal remains unclear. Tailor the prompts to what the results surfaced and use them to refine the learning direction, not to retest knowledge. For language topics, ask about listening/speaking/read/write emphasis when that choice would change the practice; do not assume "a blend" means only text-based modes. Do not trigger the interview mechanically after routine quizzes or when the goal is already clear.

Record each completed interaction only when it is useful evidence for a canonical concept. After an intentional diagnostic round, call `teach_record_round_assessment` once per concept with the exact source interaction IDs, coverage, a 0–10 synthesis score, bounded weight, and rationale. This adds a compact round-level judgment without replacing individual evidence. State what is known, what remains uncertain, and how that affects the next stage; do not block teaching on exhaustive coverage.

After each `quiz`, inspect its popup `note` and any returned `scratchpad`. The optional scratchpad contains learner-authored reasoning from a fenced block in the linked md-log; use it to adapt the next probe, never as a substitute for grading the answer. Its absence is normal—don't request one or infer it from surrounding text.

**Keep assessments strictly serial.** After a quiz or free-response answer, evaluate it and call `teach_record_attempt` immediately when it is useful mastery evidence. Wait for that tool call to return before launching another quiz, free response, or other assessment. Never bundle `teach_record_attempt` with the next learner-facing question in the same assistant turn: an interactive quiz can wait on the learner while concurrent calls run, making the assessment appear to belong to the following answer.

Keep **productive friction** intact in quizzes: require genuine retrieval or reasoning before feedback, then scaffold a miss instead of revealing the answer early. Once an answer is submitted, consider whether a ComfyUI visual or Breeze narration would materially clarify the concept or a misconception. Generate only useful assets, not a routine asset for every question; a visual may expose structure or relationships, while narration can reinforce an explanation. Never start an aid before submission if it could reveal the answer.

For constructed responses, use project-local `teach_free_response` with all needed context, a question-specific 3–5 word `summaryTitle`, and stable `conceptId`. Search `teach_find_mastery_concepts` first; reuse an exact ID for the same goal, but don't merge merely similar concepts. If the best existing mastery ID is not in the catalogue, register that same ID rather than inventing a variant. For a genuinely new goal, register a canonical concept first with a lowercase kebab-case ID, canonical name, broad-to-specific subject path, concise definition, true synonyms only, and an optional already-registered parent ID. Registration never changes existing IDs or mastery records. Grade against the goal and relevant context, then call `teach_record_attempt` exactly once with its `interactionId`, `evidenceType: "free_response"`, `outcome` (`correct`, `partial`, or `incorrect`), 0–10 `evidenceScore`, and concise correct reasoning. Include `misconception` for wrong answers. Never record canceled or unavailable interactions.

### Mastery evidence and fairness review

Record a completed `quiz` or `teach_free_response` only when you judge it useful evidence for a canonical concept; do not record `ask_user_question`, preference/clarification questions, canceled/unavailable interactions, or duplicates. Supply `conceptId` on every teaching `quiz`; search `teach_find_mastery_concepts` before creating one. Binary answers score 10/correct or 0/incorrect, including “I don't know.” For nuanced responses, score 0–10 for alignment with the goal using only relevant curriculum/note context.

Infer 0–10 `confidence` from the scratchpad, quiz note, or answer, including doubt or second-guessing; don't require an explicit rating. Use neutral `5` only if confidence can't be inferred. Add a short `reasoningSummary` grounded in his words when useful; it is continuity evidence, not hidden chain-of-thought.

Use a clean-room mastery critic only when an independent check may improve a complex, ambiguous, nuanced, or borderline grade; skip clear answers. If available, choose a low-cost critic from a different provider (`mastery-critic-anthropic` for OpenAI, `mastery-critic-google` for Anthropic, `mastery-critic-openai` for Google; otherwise any different-provider profile). Invoke synchronously through `Agent`, sharing only the question, answer and authored reasoning, short rubric/goal, and proposed grade rationale. Do not include mastery scores, prior learner history, unrelated note/transcript content, or hidden chain-of-thought. Make the final call. If the selected model/provider or Agent tool is unavailable, proceed without critique.

Call `teach_record_attempt` once with the complete exact `interactionId`, `conceptId`, `outcome`, `evidenceType`, 0–10 `evidenceScore`, `confidence`, and learner-facing `explanation`; add `reasoningSummary` and `misconception` when useful. A mastery score is available from the first recorded event. Confidence lightly sets the default interaction weight (0.8–1.0); an explicit interaction `evidenceWeight` is bounded to 0.1–1. A round assessment is one additional concept-level event bounded to weight 1–3. The 0–10 weighted average drives mastery; `outcome` describes the result but does not replace the score. Do not include an answer callout in the md-log by default; session history and the evidence journal retain scored values without duplicating verbose per-answer feedback.

Vault-root `mastery-concepts.json` stores canonical names, subject paths, definitions, aliases, parent IDs, and retired-ID redirects. Search with `teach_find_mastery_concepts` before choosing an ID; its compact `evidenceContext` includes recent mastery-journal events as well as note projections. Treat ranked concept results as candidates, not automatic matches. Verify that learning goal and scope match before reusing an ID; aliases are true synonyms, never merely related skills. Register genuinely new concepts with `teach_register_mastery_concept` before recording evidence. Unique interaction and round events are stored in vault-root `mastery-evidence.json`; linked-note frontmatter is a replayed projection. When journal events exist, replay repairs stale note projections. Without journal history, conflicting legacy aggregates remain an explicit blocker.

For an intentional diagnostic round, use the existing quiz/free-response forms and grade each useful interaction normally. Then call `teach_record_round_assessment` once per concept with exact source IDs, covered subskills, a concise rationale, score, confidence, and a 1–3 weight. It refuses unrecorded or cross-concept source interactions. Do not add a round event for routine isolated checks or reuse the same source interactions in another round.

Exact-ID matches continue to sync vault-wide and add reciprocal `related` wikilinks. To consolidate IDs, verify they assess the same goal, call `teach_preview_mastery_merge`, present its affected notes/evidence/result/blockers, and obtain explicit learner approval before calling `teach_merge_mastery_concepts` with the unchanged preview token. Never merge from similarity alone. A stale preview, conflicting duplicate event, or opaque legacy baseline blocks the merge; do not bypass the block. The merge preserves the old ID as a redirect and replays unique events under the canonical ID. If there is no event journal and legacy note projections conflict, explain the blocker rather than guessing. Use mastery to choose probes, never to bias grading. Never manually edit mastery/frontmatter or rewrite existing note content.

These namespaced tools record the learner's answer, feedback, and concept mastery in the session and linked md-log; do not call the globally installed `learning_ask_free_response` or `learning_record_attempt` tools for this project workflow.

### Assessment media policy

Choose media from the learning objective, not from a blanket "consider media" afterthought. For each focused sequence, make an explicit modality decision before composing the probes. Use ComfyUI when a visual can clarify a structure/process; use Breeze when speech itself is useful practice or when narration materially reinforces a correction. For language study, honor a requested or selected listening component by including target-language speech, not only an English narration of the explanation. If a translation or target sentence must remain unknown until the learner tries, do not reveal it in the visible prompt/transcript before the attempt; if the linked-note audio flow cannot keep it hidden, generate speech after the attempt as reinforcement and do not treat it as listening evidence. It is valid to generate neither when neither adds value; do not generate media mechanically for every question or let it leak answers.

### ComfyUI visual aid

Use a generated visual when it can clarify structure, relationships, or a process, and honor explicit image requests. **Never start image generation while TTS generation is underway.** A linked md-log is required; otherwise ask him to link one with `/md-log`. Call only `teach_comfyui_paint` with a plain-language `prompt`, specific human-readable `captionTitle`, concise 1–2 sentence `caption`, and `insertAfter` set to an exact, unique sentence/paragraph in the managed transcript. Base title and caption on the prompt and lesson—not image bytes. The caption explains what the image shows and means; it appears italicized in a titled quote callout. Prefer current request/explanation text for placement, not a generic title like “Image Note.” The tool inserts `%%pi-comfyui-image:<id>%%` and launches `comfyui-image-maker` through global `@tintinweb/pi-subagents` `Agent` in the background; a runtime guard rejects direct launches. Don't call other image/attachment tools or provide workflow details, boxes, ratios, or filenames.

Continue teaching without waiting. The image-maker uses `explabs/claude-haiku-5.5` to create the ComfyUI API call and copies the result to `001-Attachments/~comfyui`; the marker becomes a titled quote caption above a standard Obsidian embed, preserved at that position on transcript refresh. Don't inspect the image or repeat its wikilink in chat. On failure, give the exact error and offer Retry or Pause/Exit; retry only after he chooses.

### Breeze TTS narration

Use Breeze only when narration materially helps. Call `teach_breeze_tts` with the exact, unique logged concept passage and explicitly set `executionMode`. Use `"synchronous"` when direct control of the spoken script matters and waiting for synthesis is acceptable; set `scriptMode: "exact"` and provide the exact `narrationText`, a concise `voiceInstruction`, and an exactly five-word `audioDescription`. Use `"background"` when generation should proceed asynchronously; set `scriptMode: "exact"` when the main-authored `narrationText` must be preserved, or `"interpretive"` to authorize the subagent to reframe the logged concept to suit the voice. In interpretive mode, match the cloned voice's stored personality/style instructions or choose a fresh original personality for the standard voice. Preserve the facts and learning point, and avoid recognizable character catchphrases or dialogue. Both routes validate and place the WAV in the linked note; never launch the subagent directly.

For a fresh/empty linked note, choose one valid clone source in `breeze-voices.json` or the built-in standard voice. If no session choice exists, the first request prompts; selection is saved and reused for the session. `scripts/breeze_voice_presets.py` manages clone WAV/transcript folder pairs and imports optional `style-instructions.json`. For clones, generation randomly selects a matching six-digit WAV and `{id}-transcript.txt`; saved style instructions guide delivery. Both routes return the exact transcript used by synthesis. On success, the extension validates and stores the uniquely named WAV in `001-Attachments/~breezetts` (standard voice omits the voice prefix), replaces the marker with an Obsidian embed, and md-log preserves pending markers/embeds on refresh. On failure, show the exact error/output and ask with `ask_user_question`:

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

Only an explicit Yes retries, using the returned marker ID and the same placeholder; a retry selects a new random reference pair. If the learner explicitly chooses No, call `teach_breeze_tts_cancel` to remove it. Respect Other as a custom direction rather than treating it as Yes or No. Do not claim that audio exists until the selected generation route reports success.

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

On an allow answer, call the custom agent synchronously using the installed `pi-subagents` `Agent` tool, e.g. `Agent({ subagent_type: "curriculum-orchestrator", prompt: "<self-contained topic, goal, learner baseline, diagnostic answers and scratchpad reasoning, plus a concise linked-note context brief>", description: "Plan <topic> curriculum", run_in_background: false })`. The orchestrator does not inherit this conversation or read the linked note, so use the linked-note transcript already supplied in your context to include the note title and relevant prior learning, learner wording, examples, unresolved questions, and any latest marked curriculum plan in full if revising it. Preserve short exact quotes where wording matters and distinguish learner evidence from teacher explanations or your inferences. Do not copy the full transcript or unrelated exchanges; if note context is unavailable, say so explicitly. Include scratchpad evidence without treating it as a replacement for graded answers.

If dispatch reports that `gemini-4-argon` is unavailable, do not substitute another model and do not continue planning in its place yet. Stop and ask the user, in their own words, whether they want to provide a specific available model or have you continue without the orchestrator. Wait for that decision. If that follow-up UI is unavailable, explain the blocker and stop.

The orchestrator's response must contain one complete learner-readable plan wrapped in the exact markers `%% curriculum-plan:start v1 %%` and `%% curriculum-plan:end v1 %%`. Present the complete marked block in your normal assistant response, along with the plan explanation and Mermaid dependency map, so `md-log` records it as ordinary session content. Do not rely on a subagent result alone to persist the plan. When revising an existing plan, use the most recent marked plan as context and append a new clearly identified version; do not erase earlier history or the learner's note content.

- **Research once, when useful and approved.** If external verification would materially improve the plan, obtain explicit research consent before any researcher is dispatched. The curriculum orchestrator may perform one focused research delegation when that consent is included in its brief; otherwise it may identify research gaps for you. If the orchestrator has already supplied suitable research, do not dispatch another researcher. If the user declines or research is unavailable, state the limitation and do not invent findings.
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
