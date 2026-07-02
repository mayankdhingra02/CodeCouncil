# Reconciled Plan

Session: `20260702-040811-add-password-complexity-validation-and-tests-for`
Reconciler: `codex` (OpenAI Codex CLI)
Generated: 2026-07-02T04:12:46.905Z
Confidence: 88%

## Bias Disclosure

Warning: The reconciler also produced one of the source plans, so this
reconciliation may contain model self-preference bias.

## Bias Metrics

- Reconciler: `codex`
- Reconciler was also planner: yes
- Total disagreements resolved: 5
- Reconciler-plan selections: 0
- Other-planner selections: 1
- Synthesis selections: 4
- Unknown selections: 0

| Source Plan Agent | Selections |
| --- | ---: |
| `claude` | 1 |
| `codex` | 0 |

## Summary

Add independent password complexity checks to signup validation and targeted
tests for missing uppercase, lowercase, and number requirements.

## Assumptions

- Complexity rules are additive to the existing 8-character minimum.
- Each missing password requirement should produce its own validation error.
- ASCII classes `[A-Z]`, `[a-z]`, and `[0-9]` are acceptable unless product
  guidance says otherwise.
- `createSignupPayload` does not need logic changes because it already returns
  `validateSignup` errors.

## Files

- `src/signup.mjs`
- `test/signup.test.mjs`

## Steps

- In `src/signup.mjs`, add password checks after the existing length check for
  missing uppercase, lowercase, and number.
- Use exact, stable messages such as `password must contain an uppercase letter`,
  `password must contain a lowercase letter`, and `password must contain a number`.
- Update the valid signup test password from `correct horse` to a compliant value
  such as `Correct1Horse`.
- Keep the invalid email plus short password test focused by using a short
  password that satisfies complexity, such as `A1short`.
- Add three focused tests in `test/signup.test.mjs`, one each for missing
  uppercase, missing lowercase, and missing number, asserting exact error arrays.
- Run `npm test`.

## Risks

- Previously valid passwords without uppercase or numeric characters will now be
  rejected.
- Exact error arrays make ordering observable, so new checks should be added in
  a deliberate order after the length check.
- ASCII-only validation may not match future Unicode password expectations.

## Resolution Highlights

- Chose synthesis for the main implementation: Claude's concrete regex/error
  details plus Codex's cleaner test isolation.
- Kept Codex's ASCII/Unicode and caller-impact risk notes.
- Accepted Claude's warning that this is a breaking validation behavior change.
- Rejected expanding the existing short-password test with unrelated complexity
  errors because a focused test suite is easier to review.

## Open Question For Human

Should uppercase, lowercase, and number checks be ASCII-only, or should Unicode
letters and digits count?
