/**
 * @fileoverview TDD RED — Engine must redact sensitive fields before persisting metadata.input (Task #2900 P1)
 *
 * Module under test: `packages/core/src/env/workflow/engine/engine.ts`
 *                       + a new helper (likely in utils/sensitive-redact.ts)
 *
 * Background (Task #2898 verification + Task #2900 P1):
 *   `SessionComponent.updateSession` / engine.ts:447,505,518 stores the entire
 *   workflow `input` object into `metadata.input` without redacting sensitive
 *   fields. Even though the wiki workflow v2.4.0 deprecated the `password`
 *   input field and uses LDAP_PASSWORD env var instead, callers can still pass
 *   `password: "..."` (Task #2898 test #4 reproduced this). The persisted
 *   session metadata then contains the cleartext password in JSON form.
 *
 *   Same risk for: apiKey, token, secret, LDAP_PASSWORD (if accidentally passed
 *   as input).
 *
 * Contract after GREEN:
 *   - When engine.start() persists metadata.input, sensitive keys are replaced
 *     with "[REDACTED]" sentinel.
 *   - Sensitive key list (case-insensitive):
 *       password, ldap_password, apikey, api_key, token, secret, auth,
 *       access_token, refresh_token, authorization, cookie, private_key
 *   - Non-sensitive fields (assignee, iterationId, projectId, userName, etc.)
 *     pass through unchanged.
 *   - Nested objects/arrays are recursively redacted.
 *   - Recdaction happens BEFORE sessionComponent.create() / update().
 *
 * Fix locations:
 *   - engine.ts:447  → input: redactSensitiveFields(options?.input)
 *   - engine.ts:505,518 → merge must redact before write
 */

import { describe, it, expect } from "bun:test";
import { redactSensitiveFields } from "../utils/sensitive-redact";

// =============================================================================
// Helpers
// =============================================================================

function deepGet(obj: any, path: string): any {
  return path.split(".").reduce((o: any, k: string) => (o == null ? undefined : o[k]), obj);
}

// =============================================================================
// RED Tests
// =============================================================================

describe("redactSensitiveFields (Task #2900 P1) — engine must use this before persisting metadata.input", () => {
  it("RED: top-level 'password' field is redacted to '[REDACTED]'", () => {
    const input = {
      assignee: "alice",
      password: "super-secret-123",
    };
    const out = redactSensitiveFields(input);
    expect(out.password).toBe("[REDACTED]");
    expect(out.assignee).toBe("alice");
  });

  it("RED: case-insensitive — PASSWORD, Password, PaSsWoRd all redacted", () => {
    const out = redactSensitiveFields({ PASSWORD: "x", Password: "y", PaSsWoRd: "z" });
    expect(out.PASSWORD).toBe("[REDACTED]");
    expect(out.Password).toBe("[REDACTED]");
    expect(out.PaSsWoRd).toBe("[REDACTED]");
  });

  it("RED: LDAP_PASSWORD, apiKey, api_key, token, secret, auth all redacted", () => {
    const input = {
      LDAP_PASSWORD: "ldapsecret",
      apiKey: "ak-123",
      api_key: "ak-456",
      token: "tok-789",
      secret: "sec-abc",
      auth: "Basic xyz",
      access_token: "at-1",
      refresh_token: "rt-1",
      authorization: "Bearer xyz",
      cookie: "sid=abc",
      private_key: "-----BEGIN PRIVATE KEY-----",
      // Non-sensitive (should pass through)
      userName: "alice",
      projectId: "P-1",
      iterationId: "I-1",
    };
    const out = redactSensitiveFields(input);
    for (const k of [
      "LDAP_PASSWORD", "apiKey", "api_key", "token", "secret", "auth",
      "access_token", "refresh_token", "authorization", "cookie", "private_key",
    ]) {
      expect(out[k]).toBe("[REDACTED]");
    }
    expect(out.userName).toBe("alice");
    expect(out.projectId).toBe("P-1");
    expect(out.iterationId).toBe("I-1");
  });

  it("RED: nested objects are recursively redacted", () => {
    const input = {
      config: {
        user: "alice",
        credentials: {
          password: "nested-secret",
          apiKey: "nested-ak",
        },
      },
    };
    const out = redactSensitiveFields(input);
    expect(deepGet(out, "config.user")).toBe("alice");
    // 'credentials' is NOT a sensitive key — we recurse into it
    expect(deepGet(out, "config.credentials.password")).toBe("[REDACTED]");
    expect(deepGet(out, "config.credentials.apiKey")).toBe("[REDACTED]");
  });

  it("RED: a sensitive key whose value is an object gets fully redacted (auth:{...} → '[REDACTED]')", () => {
    const input = {
      user: "alice",
      auth: { password: "x", token: "y" },
    };
    const out = redactSensitiveFields(input);
    expect(out.user).toBe("alice");
    expect(out.auth).toBe("[REDACTED]");
  });

  it("RED: arrays are recursively redacted", () => {
    const input = {
      items: [
        { user: "alice", password: "p1" },
        { user: "bob", token: "t2" },
      ],
    };
    const out = redactSensitiveFields(input);
    expect((out.items[0] as any).user).toBe("alice");
    expect((out.items[0] as any).password).toBe("[REDACTED]");
    expect((out.items[1] as any).user).toBe("bob");
    expect((out.items[1] as any).token).toBe("[REDACTED]");
  });

  it("RED: undefined/null input returns undefined", () => {
    expect(redactSensitiveFields(undefined)).toBeUndefined();
    expect(redactSensitiveFields(null)).toBeUndefined();
  });

  it("RED: non-object input (string) passes through unchanged", () => {
    expect(redactSensitiveFields("userQuery")).toBe("userQuery");
  });

  it("RED: input is not mutated (returns a copy)", () => {
    const input = { password: "secret", user: "alice" };
    const out = redactSensitiveFields(input);
    expect(out).not.toBe(input);
    expect(input.password).toBe("secret"); // original untouched
    expect(out.password).toBe("[REDACTED]");
  });
});