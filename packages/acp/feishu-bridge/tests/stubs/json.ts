/**
 * Typed JSON access helpers for specs that assert on rendered card JSON
 * (replaces Go's map[string]any test plumbing without `any`).
 *
 * @module dsh-feishu-bridge/tests-json-helpers
 */

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json }
export type JsonObj = { [key: string]: Json }

/** Narrow a JSON value to an object (empty object when not one). */
export function jObj(v: unknown): JsonObj {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? v as JsonObj : {}
}

/** Narrow a JSON value to an array (empty array when not one). */
export function jArr(v: unknown): Json[] {
  return Array.isArray(v) ? v as Json[] : []
}

/** Narrow a JSON value to a string (empty string when not one). */
export function jStr(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/** Parse a JSON string as an object. */
export function jParse(s: string): JsonObj {
  return jObj(JSON.parse(s) as Json)
}
