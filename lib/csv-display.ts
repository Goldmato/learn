export interface CsvDisplayRow {
  values: string[]
  row_number?: number
}

export interface CsvDisplayReport {
  columns?: string[]
  rows?: CsvDisplayRow[]
  groups?: Array<{ group: string; rows: number; value: number | null }>
  matchedRows?: number
  totalRows?: number
  total_rows?: number
  operation?: string
}

const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g
const MAX_DISPLAY_CHARS = 16_000
const COLLAPSED_PREVIEW_CHARS = 700

function cleanText(value: string): string {
  return value
    .replace(/\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\)|[@-_])/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "  ")
    .replace(CONTROL_CHARACTERS, "")
}

function sliceCharacters(value: string, count: number): string {
  return Array.from(value).slice(0, count).join("")
}

export function sanitizeCsvDisplayText(value: string): string {
  return cleanText(value)
}

export function formatCsvDisplay(report: CsvDisplayReport): string {
  if (report.groups) {
    if (report.groups.length === 0) return "No groups matched."
    return report.groups.map(({ group, rows, value }) => `${cleanText(group)}: ${value ?? "no numeric values"} (${rows} rows)`).join("\n")
  }

  const rows = report.rows ?? []
  if (rows.length === 0) {
    return report.operation === "inspect" ? "No sample records." : "No matching records."
  }

  const columns = report.columns ?? []
  const entries = rows.map((row) => {
    const record = row.row_number === undefined ? "" : `Record ${row.row_number}\n`
    const values = columns.map((column, index) => {
      const value = cleanText(row.values[index] ?? "")
      return `${cleanText(column)}: ${value || "(empty)"}`
    })
    return `${record}${values.join("\n")}`
  })
  const text = entries.join("\n\n")
  if (text.length <= MAX_DISPLAY_CHARS) return text
  return `${sliceCharacters(text, MAX_DISPLAY_CHARS).trimEnd()}\n\n… [display truncated]`
}

export function formatCsvTextPreview(text: string, expanded: boolean): string {
  const characters = Array.from(text)
  if (expanded || characters.length <= COLLAPSED_PREVIEW_CHARS) return text
  return `${characters.slice(0, COLLAPSED_PREVIEW_CHARS).join("").trimEnd()}…\n${characters.length - COLLAPSED_PREVIEW_CHARS} more characters — Ctrl+O to expand`
}

function isCsvDisplayReport(value: unknown): value is CsvDisplayReport {
  if (!value || typeof value !== "object") return false
  const candidate = value as Record<string, unknown>
  return (
    Array.isArray(candidate.columns) &&
    (Array.isArray(candidate.rows) || Array.isArray(candidate.groups))
  )
}

export function displayCsvToolResult(
  details: unknown,
  content: Array<{ type: string; text?: string }>,
  expanded: boolean,
): string {
  if (details && typeof details === "object" && "displayText" in details) {
    const displayText = details.displayText
    if (typeof displayText === "string") return formatCsvTextPreview(cleanText(displayText), expanded)
  }

  const text = content.find((item) => item.type === "text")?.text
  if (text) {
    try {
      const report: unknown = JSON.parse(text)
      if (isCsvDisplayReport(report)) return formatCsvTextPreview(formatCsvDisplay(report), expanded)
      return "CSV result is available; rerun the query to display matching entries."
    } catch {
      return cleanText(text)
    }
  }
  return text ? cleanText(text) : "CSV query completed."
}
