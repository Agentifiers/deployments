import { describe, expect, it } from "bun:test";
import { guardReadOnlyQuery, MAX_QUERY_LENGTH, UnsafeQueryError } from "./sql-guard.ts";

describe("read-only SQL guard", () => {
  it("caps a SELECT without a LIMIT one row past the maximum to reveal truncation", () => {
    expect(guardReadOnlyQuery("SELECT event_type FROM events", 100)).toEqual({
      limit: 101,
      sql: "SELECT event_type FROM events\nLIMIT 101",
    });
  });

  it("keeps a trailing LIMIT within the cap and clamps a larger one or ALL", () => {
    expect(guardReadOnlyQuery("select * from events limit 10", 100).sql).toBe(
      "select * from events limit 10",
    );
    expect(guardReadOnlyQuery("SELECT * FROM events LIMIT 100", 100).limit).toBe(100);
    expect(guardReadOnlyQuery("SELECT * FROM events LIMIT 99999999999999999999", 100).sql).toBe(
      "SELECT * FROM events LIMIT 101",
    );
    expect(guardReadOnlyQuery("SELECT * FROM events LIMIT ALL", 5).sql).toBe(
      "SELECT * FROM events LIMIT 6",
    );
  });

  it("caps the outer query, not a LIMIT inside a subquery, and drops one trailing semicolon", () => {
    expect(
      guardReadOnlyQuery(
        "WITH latest AS (SELECT * FROM events ORDER BY ingested_at DESC LIMIT 5000) SELECT * FROM latest;  ",
        50,
      ).sql,
    ).toBe(
      "WITH latest AS (SELECT * FROM events ORDER BY ingested_at DESC LIMIT 5000) SELECT * FROM latest\nLIMIT 51",
    );
    expect(guardReadOnlyQuery("(SELECT 1) UNION ALL (SELECT 2)", 10).sql).toBe(
      "(SELECT 1) UNION ALL (SELECT 2)\nLIMIT 11",
    );
  });

  it("ignores keywords inside string literals and quoted identifiers", () => {
    const sql =
      "SELECT \"update\", count(*) FROM events WHERE event_type = 'agent.deleted' OR payload_json LIKE '%DROP TABLE x; -- /* it''s */%' GROUP BY 1";
    expect(guardReadOnlyQuery(sql, 10).sql).toBe(`${sql}\nLIMIT 11`);
  });

  it("accepts identifiers that merely contain or resemble forbidden words", () => {
    expect(() =>
      guardReadOnlyQuery("SELECT deleted_at, updated_by, constructor, created FROM events", 10),
    ).not.toThrow();
  });

  it.each([
    ["CREATE TABLE copy AS SELECT * FROM events", "Only SELECT and WITH"],
    ["DROP TABLE events", "Only SELECT and WITH"],
    ["INSERT INTO events SELECT * FROM events", "Only SELECT and WITH"],
    [
      "UNLOAD (SELECT * FROM events) TO 's3://bucket/x' WITH (format = 'PARQUET')",
      "Only SELECT and WITH",
    ],
    ["MSCK REPAIR TABLE events", "Only SELECT and WITH"],
    ["SHOW TABLES", "Only SELECT and WITH"],
    ["DESCRIBE events", "Only SELECT and WITH"],
    ["EXPLAIN ANALYZE SELECT * FROM events", "Only SELECT and WITH"],
    ["VALUES 1", "Only SELECT and WITH"],
    ["", "Only SELECT and WITH"],
    ["WITH x AS (SELECT 1) DELETE FROM events", "DELETE is not allowed"],
    ["WITH x AS (SELECT 1) INSERT INTO events SELECT * FROM x", "INSERT is not allowed"],
    [
      "SELECT * FROM events WHERE event_id IN (SELECT 1) UNION SELECT * FROM (UPDATE events SET x = 1)",
      "UPDATE is not allowed",
    ],
    [
      "USING EXTERNAL FUNCTION leak(x varchar) RETURNS varchar LAMBDA 'fn' SELECT leak(event_id) FROM events",
      "Only SELECT and WITH",
    ],
    ["SELECT leak(event_id) FROM events USING EXTERNAL FUNCTION leak", "EXTERNAL is not allowed"],
    ["SELECT 1; DROP TABLE events", "one statement"],
    ["SELECT 1;;", "one statement"],
    ["SELECT 1 -- ; DROP TABLE events", "Comments"],
    ["SELECT 1 /* hidden */ FROM events", "Comments"],
    ["SELECT/**/1", "Comments"],
    ["SELECT `event_id` FROM events", "Backtick"],
    ["SELECT 'unterminated FROM events", "unterminated"],
    ["SELECT (1 FROM events", "unbalanced"],
    ["SELECT 1) FROM (events", "unbalanced"],
    ["SELECT * FROM events FETCH FIRST 10 ROWS ONLY", "FETCH"],
    ["SELECT * FROM events LIMIT 10 UNION SELECT * FROM events", "LIMIT must end"],
    ["SELECT * FROM events LIMIT 1 + 1", "LIMIT must end"],
    ["SELECT * FROM events LIMIT ?", "LIMIT must be a whole number"],
    ["SELECT * FROM events LIMIT 1.5", "LIMIT must be a whole number"],
  ])("rejects %p", (sql, message) => {
    expect(() => guardReadOnlyQuery(sql, 10)).toThrow(UnsafeQueryError);
    expect(() => guardReadOnlyQuery(sql, 10)).toThrow(message);
  });

  it("rejects oversized statements and a nonsensical row cap", () => {
    expect(() => guardReadOnlyQuery(`SELECT '${"x".repeat(MAX_QUERY_LENGTH)}'`, 10)).toThrow(
      "characters",
    );
    expect(() => guardReadOnlyQuery("SELECT 1", 0)).toThrow(RangeError);
  });
});
