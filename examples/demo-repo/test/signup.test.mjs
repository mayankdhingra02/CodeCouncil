import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createSignupPayload, validateSignup } from "../src/signup.mjs";

describe("signup validation", () => {
  it("accepts a valid signup", () => {
    assert.deepEqual(validateSignup({
      email: "maya@example.com",
      password: "correct horse"
    }), {
      errors: [],
      ok: true
    });
  });

  it("rejects invalid email and short password", () => {
    const response = createSignupPayload({
      email: "invalid",
      password: "short"
    });

    assert.equal(response.status, 400);
    assert.deepEqual(response.body.errors, [
      "email must be a valid email address",
      "password must be at least 8 characters"
    ]);
  });
});
