import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { Text } from "@earendil-works/pi-tui"
import { Type } from "@sinclair/typebox"
import { readFileSync, realpathSync, statSync } from "node:fs"
import { isAbsolute, relative, resolve, sep } from "node:path"
import { displayCsvToolResult, formatCsvDisplay, sanitizeCsvDisplayText } from "../lib/csv-display.ts"
import { parseCsv, queryCsv } from "../lib/csv-query.ts"

const MAX_FILE_BYTES = 10 * 1024 * 1024
const MAX_OUTPUT_CHARS = 18_000
const MAX_RESULTS = 20

const FilterSchema = Type.Object({
  column: Type.String({ minLength: 1, description: "Exact CSV header name." }),
  operator: Type.Union([
    Type.Literal("eq"),
    Type.Literal("ne"),
    Type.Literal("contains"),
    Type.Literal("gt"),
    Type.Literal("gte"),
    Type.Literal("lt"),
    Type.Literal("lte"),
    Type.Literal("is_empty"),
    Type.Literal("not_empty"),
  ]),
  value: Type.Optional(Type.Union([Type.String(), Type.Number()])),
})

const CsvQueryParams = Type.Object({
  path: Type.String({ minLength: 1, description: "CSV path relative to the current workspace, or an absolute path inside it." }),
  operation: Type.Union([Type.Literal("inspect"), Type.Literal("query"), Type.Literal("search")]),
  query: Type.Optional(Type.String({ maxLength: 500, description: "Search terms or natural-language query. Used by the search operation." })),
  filters: Type.Optional(Type.Array(FilterSchema, { maxItems: 20 })),
  sort_by: Type.Optional(Type.String({ minLength: 1 })),
  sort_order: Type.Optional(Type.Union([Type.Literal("asc"), Type.Literal("desc")])),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_RESULTS })),
  group_by: Type.Optional(Type.String({ minLength: 1 })),
  aggregate: Type.Optional(
    Type.Union([
      Type.Literal("count"),
      Type.Literal("sum"),
      Type.Literal("avg"),
      Type.Literal("min"),
      Type.Literal("max"),
    ]),
  ),
  aggregate_column: Type.Optional(Type.String({ minLength: 1 })),
})

function resolveWorkspaceCsv(path: string): { absolutePath: string; displayPath: string } {
  const root = realpathSync(process.cwd())
  const requestedPath = resolve(root, path)
  const absolutePath = realpathSync(requestedPath)
  const relativePath = relative(root, absolutePath)
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error("CSV path must resolve inside the current workspace.")
  }
  const stat = statSync(absolutePath)
  if (!stat.isFile()) throw new Error("CSV path must point to a regular file.")
  if (stat.size > MAX_FILE_BYTES) {
    throw new Error(`CSV is ${stat.size} bytes; the current read-only tool limit is ${MAX_FILE_BYTES} bytes.`)
  }
  return { absolutePath, displayPath: relativePath || "." }
}

function compactRows(
  rows: Array<{ rowNumber: number; values: Record<string, string>; score?: number }>,
  columns: string[],
): Array<{ row_number: number; score?: number; values: string[] }> {
  const maxCellLength = Math.max(24, Math.min(800, Math.floor(8_000 / Math.max(columns.length, 1))))
  return rows.map((row) => ({
    row_number: row.rowNumber,
    ...(row.score === undefined ? {} : { score: Number(row.score.toFixed(4)) }),
    values: columns.map((column) => {
      const value = row.values[column] ?? ""
      return value.length > maxCellLength ? `${value.slice(0, maxCellLength)}… [cell truncated]` : value
    }),
  }))
}

function boundedReport(
  report: Record<string, unknown>,
  rows: Array<{ rowNumber: number; values: Record<string, string>; score?: number }> | undefined,
  columns: string[],
): string {
  const compactedRows = rows ? compactRows(rows, columns) : undefined
  const output: Record<string, unknown> = {
    ...report,
    ...(compactedRows ? { rows: compactedRows } : {}),
  }
  let text = JSON.stringify(output, null, 2)
  if (compactedRows && text.length > MAX_OUTPUT_CHARS) {
    while (compactedRows.length > 0 && text.length > MAX_OUTPUT_CHARS) {
      compactedRows.pop()
      output.truncated = true
      text = JSON.stringify(output, null, 2)
    }
  }
  if (text.length > MAX_OUTPUT_CHARS) {
    throw new Error("CSV result metadata exceeds the tool output limit; narrow the requested columns or query.")
  }
  return text
}

export default function csvToolsExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "csv_query",
    label: "Query CSV",
    description:
      "Inspect or search a CSV inside the current workspace without loading the whole file into model context. " +
      "Use inspect first to learn exact column names and see a few sample rows. Use query for structured filters, " +
      "sorting, or aggregates. Use search with concise terms and useful synonyms for local BM25-style text ranking; " +
      "combine it with field filters to narrow candidates. Results include data-record numbers and are capped at 20 rows. " +
      "The CSV is parsed and searched locally; only the bounded result is returned to the model.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    parameters: CsvQueryParams,
    async execute(_id, params) {
      const { absolutePath, displayPath } = resolveWorkspaceCsv(params.path)
      const source = readFileSync(absolutePath, "utf8")
      const csv = parseCsv(source)

      if (params.operation === "inspect") {
        const sample = csv.rows.slice(0, 5)
        const report = {
          path: displayPath,
          operation: params.operation,
          columns: csv.columns,
          total_rows: csv.rows.length,
          sample_count: sample.length,
        }
        const text = boundedReport(report, sample, csv.columns)
        const displayText = formatCsvDisplay({
          operation: params.operation,
          columns: csv.columns,
          rows: compactRows(sample, csv.columns),
        })
        return {
          content: [{ type: "text", text }],
          details: { path: displayPath, operation: params.operation, displayText },
        }
      }

      const result = queryCsv(csv, {
        operation: params.operation,
        query: params.query,
        filters: params.filters,
        sortBy: params.sort_by,
        sortOrder: params.sort_order,
        limit: params.limit,
        groupBy: params.group_by,
        aggregate: params.aggregate,
        aggregateColumn: params.aggregate_column,
      })
      const displayedGroups = result.groups?.slice(0, params.limit ?? 10).map((group) => ({
        ...group,
        group: group.group.length > 500 ? `${group.group.slice(0, 500)}… [group truncated]` : group.group,
      }))
      const report = {
        path: displayPath,
        operation: params.operation,
        ...result,
        ...(result.groups
          ? { groups: displayedGroups, groups_truncated: result.groups.length > (params.limit ?? 10) }
          : {}),
      }
      const text = boundedReport(report, result.rows, result.columns)
      const displayText = formatCsvDisplay({
        operation: params.operation,
        columns: result.columns,
        rows: compactRows(result.rows ?? [], result.columns),
        groups: displayedGroups,
      })
      return {
        content: [{ type: "text", text }],
        details: { path: displayPath, operation: params.operation, matchedRows: result.matchedRows, displayText },
      }
    },
    renderCall(args, theme) {
      const path = sanitizeCsvDisplayText(String(args.path ?? "")).slice(0, 200)
      const requestedOperation = String(args.operation ?? "query")
      const operation = ["inspect", "query", "search"].includes(requestedOperation) ? requestedOperation : "query"
      return new Text(
        theme.fg("toolTitle", theme.bold("csv_query ")) +
          theme.fg("muted", `${operation} ${path.replace(/[\u0000-\u001F\u007F-\u009F]/g, "")}`),
        0,
        0,
      )
    },
    renderResult(result, options, theme) {
      const text = displayCsvToolResult(result.details, result.content, options.expanded)
      return new Text(theme.fg(result.isError ? "error" : "toolOutput", text), 0, 0)
    },
  })
}
