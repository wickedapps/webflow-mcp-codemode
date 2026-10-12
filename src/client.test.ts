import { expect, test } from "bun:test";
import { errorStatus } from "./client.ts";

const result = (error: unknown) => JSON.stringify({ label: "x", action: "get_page", error });

test("a structured 401 means the login was rejected", () => {
  expect(errorStatus(result({ status: 401, message: "Unauthorized" }), false)).toBe(401);
  expect(errorStatus(result({ code: "not_authorized", message: "Request not authorized" }), false)).toBe(401);
});

test("a message that only mentions 401 does not", () => {
  expect(errorStatus(result({ status: 404, message: "Room 401 not found" }), false)).toBeUndefined();
  expect(errorStatus("Error: item 401 is missing", true)).toBeUndefined();
});

test("rate limits are matched by status or message", () => {
  expect(errorStatus(result({ status: 429 }), false)).toBe(429);
  expect(errorStatus(result({ message: "GET /v2/pages returned 429" }), false)).toBe(429);
  expect(errorStatus("Too many requests: rate limit exceeded", true)).toBe(429);
});

test("successful results and plain text are left alone", () => {
  expect(errorStatus(JSON.stringify({ label: "x", action: "list_sites", result: { sites: [] } }), false)).toBeUndefined();
  expect(errorStatus("not json", false)).toBeUndefined();
});
