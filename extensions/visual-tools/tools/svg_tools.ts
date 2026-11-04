/**
 * SVG authoring loop for the svg-maker subagent — three tools that share one
 * session-scoped source file:
 *
 *   write_svg   — write the full SVG source to the session's file
 *   edit_svg    — exact-match old_text→new_text on that file (pi-edit semantics)
 *   render_svg  — render whatever is in the file → PNG, returned inline; with
 *                 `save_as`, also publish it into
 *                 <cwd>/001-Attachments/~svg
 *
 * Loaded directly by tintinweb/pi-subagents through the svg-maker agent's
 * `extensions:` path and `ext:` tool selectors. All three names map to this
 * one file.
 *
 * Rendering prefers rsvg-convert, then ImageMagick, then an installed
 * Chrome/Chromium browser. Module-level session state persists across this
 * child process's tool calls, isolated from any parallel maker.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { Type } from "@sinclair/typebox"
import { randomUUID } from "node:crypto"
import { pathToFileURL } from "node:url"
import {
  applyEdit,
  existsSync,
  findChrome,
  join,
  mkdirSync,
  publish,
  readFileSync,
  run,
  type Session,
  type RunResult,
  snippetAround,
  unlinkSync,
  writeBody,
  writeFileSync,
} from "./_common.ts"

const GROUP = "svg"
const BODY_FILE = "diagram.svg"
const RENDER_TIMEOUT_MS = 60_000

type RenderDetails = { ok: boolean; path: string; filename?: string; renderer?: string }

let session: Session | null = null

const MAX_VIEWPORT_WIDTH = 1600
const MAX_VIEWPORT_HEIGHT = 1200

function parseSvgLength(value: string | undefined): number | undefined {
  if (!value) return undefined
  const match = /^\s*(\d+(?:\.\d+)?|\.\d+)(px|in|cm|mm|pt|pc)?\s*$/i.exec(value)
  if (!match) return undefined
  const amount = Number(match[1])
  const unit = (match[2] ?? "px").toLowerCase()
  const pixelsPerUnit: Record<string, number> = { px: 1, in: 96, cm: 96 / 2.54, mm: 96 / 25.4, pt: 96 / 72, pc: 16 }
  return amount * pixelsPerUnit[unit]
}

function svgAttribute(root: string, name: string): string | undefined {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`\\s${escapedName}\\s*=\\s*(["'])(.*?)\\1`, "i").exec(root)?.[2]
}

export function getSvgViewport(source: string): { width: number; height: number } {
  const root = /<svg\b[^>]*>/i.exec(source)?.[0] ?? ""
  const viewBox = svgAttribute(root, "viewBox")?.trim().split(/[\s,]+/).map(Number)
  const viewBoxWidth = viewBox?.length === 4 && viewBox.every(Number.isFinite) ? Math.abs(viewBox[2]) : undefined
  const viewBoxHeight = viewBox?.length === 4 && viewBox.every(Number.isFinite) ? Math.abs(viewBox[3]) : undefined
  let width = parseSvgLength(svgAttribute(root, "width"))
  let height = parseSvgLength(svgAttribute(root, "height"))

  if (!width && !height && viewBoxWidth && viewBoxHeight) {
    width = viewBoxWidth
    height = viewBoxHeight
  } else if (width && !height) {
    height = viewBoxWidth && viewBoxHeight ? width * viewBoxHeight / viewBoxWidth : width * 9 / 16
  } else if (height && !width) {
    width = viewBoxWidth && viewBoxHeight ? height * viewBoxWidth / viewBoxHeight : height * 16 / 9
  }

  width = width && Number.isFinite(width) && width > 0 ? width : 1200
  height = height && Number.isFinite(height) && height > 0 ? height : 800
  const scale = Math.min(1, MAX_VIEWPORT_WIDTH / width, MAX_VIEWPORT_HEIGHT / height)
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

function renderFailure(result: RunResult): string {
  const detail = (result.stderr || result.stdout || (result.code === null ? "renderer could not be started" : "unknown error"))
    .split("\n")
    .slice(-12)
    .join("\n")
    .trim()
  return result.timedOut ? `timed out\n${detail}` : detail
}

function isPng(filePath: string): boolean {
  if (!existsSync(filePath)) return false
  const header = readFileSync(filePath).subarray(0, 8)
  return header.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
}

/** Render an SVG to PNG using an installed native renderer or browser. */
async function renderSvg(svgPath: string, outPath: string, workDir: string) {
  const failures: string[] = []
  if (existsSync(outPath)) unlinkSync(outPath)
  const res = await run("rsvg-convert", ["-z", "2", svgPath, "-o", outPath], {
    cwd: workDir,
    timeoutMs: RENDER_TIMEOUT_MS,
  })
  if (res.code === 0 && isPng(outPath)) return { ok: true as const, renderer: "rsvg-convert", failures }
  failures.push(`rsvg-convert: ${renderFailure(res)}`)

  if (existsSync(outPath)) unlinkSync(outPath)
  const magick = await run("magick", ["-density", "192", "-background", "white", svgPath, outPath], {
    cwd: workDir,
    timeoutMs: RENDER_TIMEOUT_MS,
  })
  if (magick.code === 0 && isPng(outPath)) return { ok: true as const, renderer: "ImageMagick", failures }
  failures.push(`ImageMagick: ${renderFailure(magick)}`)

  const chrome = findChrome()
  if (!chrome) {
    failures.push("Chrome/Chromium: no browser found; install one or set CHROME_PATH.")
  } else {
    const source = readFileSync(svgPath, "utf8")
    const { width, height } = getSvgViewport(source)
    if (existsSync(outPath)) unlinkSync(outPath)
    const browser = await run(chrome, [
      "--headless=new",
      "--disable-gpu",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-javascript",
      "--hide-scrollbars",
      "--no-first-run",
      "--no-default-browser-check",
      `--user-data-dir=${join(workDir, `chrome-profile-${randomUUID()}`)}`,
      "--force-device-scale-factor=2",
      `--window-size=${width},${height}`,
      `--screenshot=${outPath}`,
      pathToFileURL(svgPath).href,
    ], { cwd: workDir, timeoutMs: RENDER_TIMEOUT_MS })
    if (browser.code === 0 && isPng(outPath)) return { ok: true as const, renderer: "Chrome/Chromium", failures }
    failures.push(`Chrome/Chromium: ${renderFailure(browser)}`)
  }

  return { ok: false as const, failures }
}

export default function svgToolsExtension(pi: ExtensionAPI) {
  // ── write_svg ──────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "write_svg",
    label: "Write SVG",
    description:
      "Write the FULL SVG source to this session's managed file (your first draft " +
      "or a complete rewrite). You do NOT name the file — edit_svg and render_svg " +
      "act on the same one.\n\n" +
      "`source` is a complete `<svg ...>…</svg>` document with an explicit width/" +
      "height (or viewBox), readable font sizes, and a light or transparent " +
      "background. Writing does NOT render — call render_svg when ready. For a " +
      "small fix, prefer edit_svg over rewriting.",
    parameters: Type.Object({
      source: Type.String({ description: "The complete SVG document, from `<svg` to `</svg>`." }),
    }),
    async execute(_id, params) {
      const source = (params.source ?? "").trim()
      if (!source) throw new Error("`write_svg` requires a non-empty `source`.")
      if (!/<svg\b[\s\S]*<\/svg>/i.test(source)) throw new Error("`write_svg`: source must be a complete <svg>…</svg> document.")
      session = writeBody(GROUP, BODY_FILE, source)
      const lines = source.split("\n").length
      return {
        content: [
          { type: "text", text: `Wrote ${lines}-line SVG source.\nCall render_svg to render it, or edit_svg to tweak it.` },
        ],
        details: { ok: true, path: session.bodyPath, lines },
      }
    },
  })

  // ── edit_svg ───────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "edit_svg",
    label: "Edit SVG",
    description:
      "Make a single exact-match replacement in this session's SVG source — the " +
      "same contract as pi's built-in edit, locked to the one managed file. " +
      "`old_text` must appear EXACTLY ONCE (include surrounding context for " +
      "uniqueness); on 0 or >1 matches the call fails and nothing changes. Call " +
      "write_svg first. Editing does NOT render.",
    parameters: Type.Object({
      old_text: Type.String({ description: "Exact substring of the current source to replace (must match once)." }),
      new_text: Type.String({ description: "Replacement text for `old_text`." }),
    }),
    async execute(_id, params) {
      if (!session || !existsSync(session.bodyPath)) {
        throw new Error("edit_svg: no source yet — call write_svg first.")
      }
      const current = readFileSync(session.bodyPath, "utf8")
      const { updated, index } = applyEdit(current, String(params.old_text ?? ""), String(params.new_text ?? ""))
      writeFileSync(session.bodyPath, updated, "utf8")
      return {
        content: [
          { type: "text", text: "Applied edit. Updated region:\n```\n" + snippetAround(updated, index) + "\n```\nCall render_svg to see it." },
        ],
        details: { ok: true, path: session.bodyPath },
      }
    },
  })

  // ── render_svg ─────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "render_svg",
    label: "Render SVG",
    description:
      "Render the CURRENT session SVG source to a PNG and return it inline so you " +
      "can SEE the picture and iterate. You do NOT pass the source here — it comes " +
      "from the managed file; call write_svg first.\n\n" +
      "Iterate freely with no `save_as` (preview only). When the picture is " +
      "correct and clean, call once more with `save_as` set to a short kebab-case " +
      "topic slug: that publishes the PNG into <cwd>/001-Attachments/~svg with a unique " +
      "filename and returns the filename to embed. On a render error this returns " +
      "the error text instead of an image — fix with edit_svg and re-render.",
    parameters: Type.Object({
      save_as: Type.Optional(
        Type.String({
          description:
            "Short kebab-case topic slug (e.g. 'number-line'). When set, the " +
            "rendered PNG is published to <cwd>/001-Attachments/~svg as svg-<slug>-<timestamp>.png " +
            "and the filename is returned. Omit for a preview-only render.",
        }),
      ),
    }),
    async execute(_id, params) {
      if (!session || !existsSync(session.bodyPath)) {
        throw new Error("render_svg: no source yet — call write_svg first.")
      }
      const { workDir, bodyPath } = session
      mkdirSync(workDir, { recursive: true })

      const outPath = join(workDir, `render-${Date.now()}.png`)
      const { ok, renderer, failures } = await renderSvg(bodyPath, outPath, workDir)

      if (!ok) {
        return {
          content: [
            {
              type: "text",
              text: `SVG render FAILED — no image produced. Fix the source with edit_svg and call render_svg again.\n\nRenderer errors:\n${failures.join("\n\n")}`,
            },
          ],
          details: { ok: false, path: "" } as RenderDetails,
        }
      }

      const data = readFileSync(outPath).toString("base64")
      const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = []

      if (params.save_as) {
        const { filename, path } = publish(outPath, String(params.save_as), "~svg")
        content.push({
          type: "text",
          text: `Published to 001-Attachments/~svg/ using ${renderer}.\nfilename: ${filename}\npath: ${path}\n\nLOOK at the picture below to confirm the geometry is correct before returning it.`,
        })
        content.push({ type: "image", data, mimeType: "image/png" })
        return { content, details: { ok: true, path, filename, renderer } as RenderDetails }
      }

      content.push({
        type: "text",
        text: `Preview render using ${renderer} (not yet saved). LOOK: are coordinates, angles, directions, and proportions correct? Labels clear and unclipped? Fix with edit_svg, or re-render with \`save_as\` to publish.`,
      })
      content.push({ type: "image", data, mimeType: "image/png" })
      return { content, details: { ok: true, path: outPath, renderer } as RenderDetails }
    },
  })
}
