/**
 * A small RFC 4180 CSV reader.
 *
 * Handles quoted fields containing commas, newlines and escaped quotes, plus
 * CRLF line endings and a UTF-8 BOM — all of which appear in TfL's published
 * topology extracts.
 */

export type CsvTable = {
  headers: string[];
  rows: Array<Record<string, string>>;
};

/** Split CSV text into rows of raw cells. */
export function parseCsvRows(input: string): string[][] {
  const text = input.replace(/^﻿/, "");
  const rows: string[][] = [];

  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let index = 0;

  const endField = (): void => {
    row.push(field);
    field = "";
  };

  const endRow = (): void => {
    endField();
    // Ignore the trailing empty row produced by a final newline.
    if (row.length > 1 || row[0] !== "") rows.push(row);
    row = [];
  };

  while (index < text.length) {
    const char = text[index] as string;

    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        inQuotes = false;
        index += 1;
        continue;
      }
      field += char;
      index += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      index += 1;
      continue;
    }

    if (char === ",") {
      endField();
      index += 1;
      continue;
    }

    if (char === "\r") {
      // Consume CRLF as one line ending.
      if (text[index + 1] === "\n") index += 1;
      endRow();
      index += 1;
      continue;
    }

    if (char === "\n") {
      endRow();
      index += 1;
      continue;
    }

    field += char;
    index += 1;
  }

  if (field.length > 0 || row.length > 0) endRow();

  return rows;
}

/** Parse CSV text into header-keyed records. */
export function parseCsv(input: string): CsvTable {
  const rows = parseCsvRows(input);
  const [headerRow, ...dataRows] = rows;

  if (!headerRow) return { headers: [], rows: [] };

  const headers = headerRow.map((header) => header.trim());

  const records = dataRows.map((cells) => {
    const record: Record<string, string> = {};
    headers.forEach((header, columnIndex) => {
      record[header] = (cells[columnIndex] ?? "").trim();
    });
    return record;
  });

  return { headers, rows: records };
}

/**
 * Read a header case-insensitively, so "LiftName" and "Liftname" both work.
 * Returns an empty string when the column is absent.
 */
export function readColumn(record: Record<string, string>, name: string): string {
  const direct = record[name];
  if (direct !== undefined) return direct;

  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(record)) {
    if (key.toLowerCase() === wanted) return value;
  }

  return "";
}

/** TfL packs multi-valued cells with separators; split them into a clean list. */
export function splitList(value: string): string[] {
  if (!value || value.trim().length === 0) return [];

  return value
    .split(/[;|]|,(?![^(]*\))/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** Interpret the various ways a CSV expresses a boolean. */
export function parseCsvBoolean(value: string): boolean | null {
  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0) return null;
  if (["true", "yes", "y", "1"].includes(normalized)) return true;
  if (["false", "no", "n", "0"].includes(normalized)) return false;
  return null;
}
