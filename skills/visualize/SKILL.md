---
name: visualize
description: "Add a useful visual to a lesson and place it in the linked Obsidian note. Prefer the async ComfyUI image generator for illustrations and conceptual pictures; use exact diagrams only when structure, labels, or geometry must be precise, especially for curriculum plans."
---

# Visualize

Use a visual when it reveals something that prose or a simple equation does not. Prefer the integrated ComfyUI image generator for ordinary illustrations and conceptual pictures. Reserve diagram makers (mermaid, svg) for visuals whose exact structure, labels, or geometry matter.

## Choose the visual method

1. **ComfyUI is the default** for illustrative, evocative, representative, or explanatory images: a scene, object, metaphor, process overview, or visual analogy. It can produce a useful picture without requiring the main agent to manage workflow or rendering details.
2. **Use a diagram instead** when the user explicitly asks for one, or when correctness depends on exact nodes, relationships, labels, data, or spatial geometry. This is especially useful for curriculum plans and other structured teaching materials:
   - `mermaid-maker` for dependency graphs, flowcharts, sequences, state machines, trees, and other node-and-relationship diagrams.
   - `svg-maker` for exact coordinate geometry, number lines, vectors, plots, and custom layouts.
3. Do not ask ComfyUI to render exact text, data charts, labeled schemas, or a diagram whose edges or measurements must be exact; generated images can distort those details. Do not use a diagram maker to produce a decorative illustration.
4. If a visual adds no information, skip it.

## Request an illustration with ComfyUI

Use the single `teach_comfyui_paint` tool for an ordinary image request. It starts the ComfyUI generator subagent in the background, inserts a temporary marker at the selected point in the linked md-log note, and later replaces it with a caption and vault attachment embed.

Provide:

- `prompt`: a clear, plain-language description of the image. Describe the subject, meaningful visual relationships, and style; do not specify API/workflow details or ask for exact rendered text.
- `captionTitle`: a concise, human-readable title naming the subject of the image; avoid generic labels such as "Image Note".
- `caption`: one or two short sentences saying what the image shows and what it represents. It appears italicized and quoted inside the titled callout.
- `insertAfter`: an exact, unique sentence or paragraph already present in the managed linked-note transcript, chosen where the image best supports the explanation.

The tool requires a linked md-log note. If no note is linked or no suitable transcript anchor exists, do not bypass the tool or launch the image-maker directly. Link the note or add suitable explanatory text first. The generator chooses its own aspect ratio and layout. The tool handles the marker, background subagent, vault copy, and final Obsidian embed; do not wait for image bytes, inspect the generated image, manually move it, or add a second embed. The image is asynchronous, so continue the lesson without implying it is already complete.

## Request a precise diagram

Dispatch the suitable maker subagent through tintinweb's `pi-subagents` `Agent` tool. Give it one idea and the minimal set of elements needed to express it. Do not delegate to both makers for the same visual.

- Use `mermaid-maker` for structure and relationships. Keep labels short and prefer a small number of truthful nodes and edges.
- Use `svg-maker` only when exact positions, shapes, coordinates, or proportions matter. State the values and relationships precisely; do not leave geometry to visual guesswork.

The maker must render a preview, inspect the returned image, correct any mistakes, and publish only after verification. SVG images are saved in `001-Attachments/~svg`; Mermaid images are saved in `001-Attachments/~mermaid`. If a maker cannot make a correct visual, it must return `RESULT: NONE`; do not invent a substitute. When a diagram maker returns a published filename, embed that file in the lesson using the actual filename and path it returned.

## Keep the visual focused

Choose one idea and remove anything that does not make it clearer. Avoid decorative complexity, unsupported details, and dense labels. Introduce the visual with a short sentence that explains why it is useful; do not narrate every visible element.
