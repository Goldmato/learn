export type CsvOperator = "eq" | "ne" | "contains" | "gt" | "gte" | "lt" | "lte" | "is_empty" | "not_empty"

export interface CsvFilter {
  column: string
  operator: CsvOperator
  value?: string | number
}

export interface CsvRow {
  rowNumber: number
  values: Record<string, string>
}

export interface ParsedCsv {
  columns: string[]
  rows: CsvRow[]
}

export interface CsvQueryOptions {
  operation: "query" | "search"
  query?: string
  filters?: CsvFilter[]
  sortBy?: string
  sortOrder?: "asc" | "desc"
  limit?: number
  groupBy?: string
  aggregate?: "count" | "sum" | "avg" | "min" | "max"
  aggregateColumn?: string
}

export interface CsvQueryResult {
  columns: string[]
  totalRows: number
  matchedRows: number
  rows?: Array<CsvRow & { score?: number }>
  groups?: Array<{ group: string; rows: number; value: number | null }>
}

const SEARCH_TOKEN = /[\p{L}\p{N}]+/gu
const CJK_CHARACTER = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]$/u
const MAX_DATA_ROWS = 100_000

function detectDelimiter(source: string): string {
  const delimiters = [",", "\t", ";"]
  const counts = new Map(delimiters.map((delimiter) => [delimiter, 1]))
  const records = new Map(delimiters.map((delimiter) => [delimiter, [] as number[]]))
  let inQuotes = false
  let hasRecordContent = false

  const finishRecord = () => {
    if (hasRecordContent) {
      for (const delimiter of delimiters) records.get(delimiter)!.push(counts.get(delimiter)!)
    }
    for (const delimiter of delimiters) counts.set(delimiter, 1)
    hasRecordContent = false
  }

  for (let index = 0; index < source.length; index++) {
    const character = source[index]
    if (inQuotes) {
      if (character === '"') {
        if (source[index + 1] === '"') index++
        else inQuotes = false
      }
      hasRecordContent = true
      continue
    }
    if (character === '"') {
      inQuotes = true
      hasRecordContent = true
    } else if (character === "\r" || character === "\n") {
      finishRecord()
      if (character === "\r" && source[index + 1] === "\n") index++
    } else if (counts.has(character)) {
      counts.set(character, counts.get(character)! + 1)
      hasRecordContent = true
    } else {
      hasRecordContent = true
    }
  }
  finishRecord()

  let delimiter = ","
  let bestConsistency = 0
  let bestWidth = 1
  for (const candidate of delimiters) {
    const frequencies = new Map<number, number>()
    for (const width of records.get(candidate)!) {
      if (width > 1) frequencies.set(width, (frequencies.get(width) ?? 0) + 1)
    }
    const candidateWidth = [...frequencies.entries()].reduce(
      (best, [width, frequency]) => frequency > best.frequency || (frequency === best.frequency && width > best.width)
        ? { width, frequency }
        : best,
      { width: 1, frequency: 0 },
    )
    const consistency = candidateWidth.frequency / Math.max(records.get(candidate)!.length, 1)
    if (consistency > bestConsistency || (consistency === bestConsistency && candidateWidth.width > bestWidth)) {
      delimiter = candidate
      bestConsistency = consistency
      bestWidth = candidateWidth.width
    }
  }
  return delimiter
}

function parseRecords(source: string, delimiter: string): string[][] {
  const records: string[][] = []
  let row: string[] = []
  let field = ""
  let inQuotes = false
  let afterQuote = false
  let endedAtRecordBoundary = false

  const pushField = () => {
    row.push(field)
    field = ""
    afterQuote = false
  }
  const pushRecord = () => {
    pushField()
    if (!(row.length === 1 && row[0] === "")) records.push(row)
    row = []
    endedAtRecordBoundary = true
  }

  for (let i = 0; i < source.length; i++) {
    const char = source[i]
    if (inQuotes) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
          afterQuote = true
        }
      } else {
        field += char
      }
      endedAtRecordBoundary = false
      continue
    }

    if (afterQuote) {
      if (char === delimiter) {
        pushField()
      } else if (char === "\r" || char === "\n") {
        pushRecord()
        if (char === "\r" && source[i + 1] === "\n") i++
      } else {
        throw new Error(`Invalid character after a closing quote at character ${i + 1}.`)
      }
      endedAtRecordBoundary = char === "\r" || char === "\n"
      continue
    }

    if (char === '"') {
      if (field.length > 0) throw new Error(`Unexpected quote inside an unquoted field at character ${i + 1}.`)
      inQuotes = true
      endedAtRecordBoundary = false
    } else if (char === delimiter) {
      pushField()
      endedAtRecordBoundary = false
    } else if (char === "\r" || char === "\n") {
      pushRecord()
      if (char === "\r" && source[i + 1] === "\n") i++
    } else {
      field += char
      endedAtRecordBoundary = false
    }
  }

  if (inQuotes) throw new Error("CSV ends inside a quoted field.")
  if (!endedAtRecordBoundary || row.length > 0 || field.length > 0 || afterQuote) {
    pushField()
    if (!(row.length === 1 && row[0] === "")) records.push(row)
  }
  return records
}

export function parseCsv(source: string): ParsedCsv {
  const content = source.replace(/^\uFEFF/, "")
  const records = parseRecords(content, detectDelimiter(content))
  if (records.length === 0) throw new Error("CSV is empty or has no header row.")

  const columns = records[0].map((name) => name.trim())
  if (columns.some((name) => !name)) throw new Error("CSV header contains an empty column name.")
  if (new Set(columns).size !== columns.length) throw new Error("CSV header contains duplicate column names.")
  if (columns.length > 50) throw new Error("CSV has more than 50 columns.")
  const longHeaderIndex = columns.findIndex((name) => name.length > 128)
  if (longHeaderIndex !== -1) {
    throw new Error(
      `CSV header column ${longHeaderIndex + 1} is ${columns[longHeaderIndex].length} characters; the limit is 128. ` +
        "The file may use an unsupported delimiter; supported delimiters are comma, tab, and semicolon.",
    )
  }
  if (records.length - 1 > MAX_DATA_ROWS) throw new Error(`CSV has more than ${MAX_DATA_ROWS} data records.`)

  const rows: CsvRow[] = []
  for (let i = 1; i < records.length; i++) {
    const record = records[i]
    if (record.length > columns.length) {
      throw new Error(`CSV data record ${i} has ${record.length} fields; expected at most ${columns.length}.`)
    }
    const values: Record<string, string> = {}
    for (let j = 0; j < columns.length; j++) values[columns[j]] = record[j] ?? ""
    rows.push({ rowNumber: i, values })
  }
  return { columns, rows }
}

function numberValue(value: string): number | undefined {
  const trimmed = value.trim()
  if (!trimmed) return undefined
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : undefined
}

function compareValues(left: string, right: string): number {
  const leftNumber = numberValue(left)
  const rightNumber = numberValue(right)
  if (leftNumber !== undefined && rightNumber !== undefined) return leftNumber - rightNumber
  return left.localeCompare(right, undefined, { sensitivity: "base", numeric: true })
}

function matchesFilter(row: CsvRow, filter: CsvFilter): boolean {
  const actual = row.values[filter.column]
  if (actual === undefined) throw new Error(`Unknown CSV column in filter: ${filter.column}`)
  const expected = filter.value === undefined ? "" : String(filter.value)
  switch (filter.operator) {
    case "eq":
      return actual.localeCompare(expected, undefined, { sensitivity: "base", numeric: true }) === 0
    case "ne":
      return actual.localeCompare(expected, undefined, { sensitivity: "base", numeric: true }) !== 0
    case "contains":
      return actual.toLocaleLowerCase().includes(expected.toLocaleLowerCase())
    case "gt":
      return compareValues(actual, expected) > 0
    case "gte":
      return compareValues(actual, expected) >= 0
    case "lt":
      return compareValues(actual, expected) < 0
    case "lte":
      return compareValues(actual, expected) <= 0
    case "is_empty":
      return actual.trim() === ""
    case "not_empty":
      return actual.trim() !== ""
  }
}

function tokenize(text: string): string[] {
  const result: string[] = []
  for (const token of text.toLocaleLowerCase().match(SEARCH_TOKEN) ?? []) {
    let segment = ""
    let isCjkSegment: boolean | undefined
    const flush = () => {
      if (!segment) return
      if (isCjkSegment) {
        const characters = Array.from(segment)
        for (let index = 0; index < characters.length; index++) {
          result.push(characters[index])
          if (index + 1 < characters.length) result.push(characters[index] + characters[index + 1])
        }
      } else if (segment.length > 1) {
        result.push(segment)
      }
      segment = ""
    }

    for (const character of Array.from(token)) {
      const isCjk = CJK_CHARACTER.test(character)
      if (isCjkSegment !== undefined && isCjk !== isCjkSegment) flush()
      segment += character
      isCjkSegment = isCjk
    }
    flush()
  }
  return result
}

function rankRows(rows: CsvRow[], query: string): Array<CsvRow & { score: number }> {
  const terms = [...new Set(tokenize(query))]
  if (terms.length === 0) throw new Error("Search query must contain at least one word or number.")

  const documents = rows.map((row) => tokenize(Object.values(row.values).join(" ")))
  const averageLength = documents.reduce((sum, tokens) => sum + tokens.length, 0) / Math.max(documents.length, 1)
  const termSet = new Set(terms)
  const documentFrequencies = new Map(terms.map((term) => [term, 0]))
  for (const document of documents) {
    for (const token of new Set(document)) {
      const frequency = documentFrequencies.get(token)
      if (frequency !== undefined) documentFrequencies.set(token, frequency + 1)
    }
  }
  const ranked: Array<CsvRow & { score: number }> = []

  for (let index = 0; index < rows.length; index++) {
    const tokens = documents[index]
    const frequencies = new Map<string, number>()
    for (const token of tokens) {
      if (termSet.has(token)) frequencies.set(token, (frequencies.get(token) ?? 0) + 1)
    }
    let score = 0
    for (const term of terms) {
      const frequency = frequencies.get(term) ?? 0
      if (frequency === 0) continue
      const documentFrequency = documentFrequencies.get(term) ?? 0
      const inverseFrequency = Math.log(1 + (documents.length - documentFrequency + 0.5) / (documentFrequency + 0.5))
      const lengthNormalization = 1.2 * (0.25 + 0.75 * (tokens.length / Math.max(averageLength, 1)))
      score += inverseFrequency * ((frequency * 2.2) / (frequency + lengthNormalization))
    }
    if (score > 0) ranked.push({ ...rows[index], score })
  }
  return ranked.sort((a, b) => b.score - a.score || a.rowNumber - b.rowNumber)
}

function aggregateRows(
  rows: CsvRow[],
  groupBy: string | undefined,
  operation: NonNullable<CsvQueryOptions["aggregate"]>,
  column: string | undefined,
): CsvQueryResult["groups"] {
  if (groupBy && !rows.every((row) => groupBy in row.values)) throw new Error(`Unknown group_by column: ${groupBy}`)
  if (operation !== "count" && !column) throw new Error(`aggregate_column is required for ${operation}.`)
  if (column && !rows.every((row) => column in row.values)) throw new Error(`Unknown aggregate_column: ${column}`)

  const buckets = new Map<string, CsvRow[]>()
  for (const row of rows) {
    const key = groupBy ? row.values[groupBy] : "(all)"
    const bucket = buckets.get(key) ?? []
    bucket.push(row)
    buckets.set(key, bucket)
  }

  return [...buckets.entries()].map(([group, bucket]) => {
    if (operation === "count") return { group, rows: bucket.length, value: bucket.length }
    const values: number[] = []
    for (const row of bucket) {
      const raw = row.values[column!]
      if (!raw.trim()) continue
      const parsed = numberValue(raw)
      if (parsed === undefined) {
        throw new Error(`Cannot aggregate non-numeric value in column "${column}" at data record ${row.rowNumber}.`)
      }
      values.push(parsed)
    }
    if (values.length === 0) return { group, rows: bucket.length, value: null }
    const value =
      operation === "sum"
        ? values.reduce((sum, current) => sum + current, 0)
        : operation === "avg"
          ? values.reduce((sum, current) => sum + current, 0) / values.length
          : operation === "min"
            ? values.reduce((min, current) => Math.min(min, current), Number.POSITIVE_INFINITY)
            : values.reduce((max, current) => Math.max(max, current), Number.NEGATIVE_INFINITY)
    return { group, rows: bucket.length, value }
  })
}

export function queryCsv(csv: ParsedCsv, options: CsvQueryOptions): CsvQueryResult {
  const filters = options.filters ?? []
  for (const filter of filters) {
    if (!csv.columns.includes(filter.column)) throw new Error(`Unknown CSV column in filter: ${filter.column}`)
    if (!["is_empty", "not_empty"].includes(filter.operator) && filter.value === undefined) {
      throw new Error(`Filter "${filter.operator}" requires a value.`)
    }
  }
  if (options.sortBy && !csv.columns.includes(options.sortBy)) throw new Error(`Unknown sort_by column: ${options.sortBy}`)

  let matches = csv.rows.filter((row) => filters.every((filter) => matchesFilter(row, filter)))
  let ranked: Array<CsvRow & { score?: number }>
  if (options.operation === "search") {
    if (!options.query?.trim()) throw new Error("Search operation requires a non-empty query.")
    ranked = rankRows(matches, options.query)
    matches = ranked
  } else {
    ranked = matches
  }

  if (options.aggregate) {
    return {
      columns: csv.columns,
      totalRows: csv.rows.length,
      matchedRows: matches.length,
      groups: aggregateRows(matches, options.groupBy, options.aggregate, options.aggregateColumn),
    }
  }
  if (options.groupBy || options.aggregateColumn) {
    throw new Error("group_by and aggregate_column require an aggregate operation.")
  }

  if (options.sortBy) {
    const sign = options.sortOrder === "desc" ? -1 : 1
    ranked = [...ranked].sort(
      (a, b) => sign * compareValues(a.values[options.sortBy!], b.values[options.sortBy!]) || a.rowNumber - b.rowNumber,
    )
  }

  const limit = Math.max(1, Math.min(20, Math.floor(options.limit ?? 10)))
  return {
    columns: csv.columns,
    totalRows: csv.rows.length,
    matchedRows: matches.length,
    rows: ranked.slice(0, limit),
  }
}
