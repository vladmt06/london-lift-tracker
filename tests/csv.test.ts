import { describe, expect, it } from "vitest";
import { parseCsv, parseCsvBoolean, parseCsvRows, readColumn, splitList } from "@/lib/utils/csv";

/** The topology import parses operator-supplied CSV, so the reader is tested. */

describe("CSV parsing", () => {
  it("reads a simple table", () => {
    const table = parseCsv("A,B\n1,2\n3,4\n");

    expect(table.headers).toEqual(["A", "B"]);
    expect(table.rows).toEqual([
      { A: "1", B: "2" },
      { A: "3", B: "4" },
    ]);
  });

  it("handles quoted fields containing commas", () => {
    const table = parseCsv('Name,Areas\nLift 1,"Street, Ticket Hall"\n');

    expect(table.rows[0]?.Areas).toBe("Street, Ticket Hall");
  });

  it("handles escaped quotes", () => {
    const table = parseCsv('Name,Note\nLift 1,"He said ""step free"" here"\n');

    expect(table.rows[0]?.Note).toBe('He said "step free" here');
  });

  it("handles newlines inside quoted fields", () => {
    const rows = parseCsvRows('A,B\n1,"line one\nline two"\n');

    expect(rows).toHaveLength(2);
    expect(rows[1]?.[1]).toBe("line one\nline two");
  });

  it("handles CRLF line endings and a UTF-8 BOM", () => {
    const table = parseCsv("﻿A,B\r\n1,2\r\n");

    expect(table.headers).toEqual(["A", "B"]);
    expect(table.rows).toEqual([{ A: "1", B: "2" }]);
  });

  it("fills absent trailing columns with empty strings", () => {
    const table = parseCsv("A,B,C\n1,2\n");

    expect(table.rows[0]).toEqual({ A: "1", B: "2", C: "" });
  });

  it("returns nothing for empty input", () => {
    expect(parseCsv("")).toEqual({ headers: [], rows: [] });
  });
});

describe("column access", () => {
  it("is case-insensitive", () => {
    expect(readColumn({ LiftName: "Lift 5" }, "liftname")).toBe("Lift 5");
    expect(readColumn({ liftname: "Lift 5" }, "LiftName")).toBe("Lift 5");
  });

  it("returns an empty string for an absent column", () => {
    expect(readColumn({ A: "1" }, "Missing")).toBe("");
  });
});

describe("multi-valued cells", () => {
  it("splits on semicolons and pipes", () => {
    expect(splitList("Street; Ticket Hall; Platform 3")).toEqual([
      "Street",
      "Ticket Hall",
      "Platform 3",
    ]);
    expect(splitList("Street|Ticket Hall")).toEqual(["Street", "Ticket Hall"]);
  });

  it("returns an empty list for blank input", () => {
    expect(splitList("")).toEqual([]);
    expect(splitList("   ")).toEqual([]);
  });
});

describe("boolean cells", () => {
  it("reads the usual spellings", () => {
    expect(parseCsvBoolean("Yes")).toBe(true);
    expect(parseCsvBoolean("TRUE")).toBe(true);
    expect(parseCsvBoolean("1")).toBe(true);
    expect(parseCsvBoolean("no")).toBe(false);
    expect(parseCsvBoolean("0")).toBe(false);
  });

  it("returns null when the cell is blank or unrecognised", () => {
    expect(parseCsvBoolean("")).toBeNull();
    expect(parseCsvBoolean("maybe")).toBeNull();
  });
});
