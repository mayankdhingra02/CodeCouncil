# Reconciled Plan

Session: `20260702-170202-add-password-complexity-validation-and-tests-for`
Reconciler: `codex` (OpenAI Codex CLI)
Generated: 2026-07-02T17:06:44.618Z
Confidence: 86%

## Bias Disclosure

Warning: The reconciler also produced one of the source plans, so this reconciliation may contain model self-preference bias.

## Bias Metrics

- Reconciler: `codex`
- Reconciler was also planner: yes
- Total disagreements resolved: 6
- Reconciler-plan selections: 0
- Other-planner selections: 1
- Synthesis selections: 5
- Unknown selections: 0

| Source Plan Agent | Selections |
| --- | ---: |
| `claude` | 1 |
| `codex` | 0 |

## Plan Aliases

- `agent-a`: `claude`
- `agent-b`: `codex`

## Summary

Add three independent password complexity checks to signup validation, update existing fixtures that would fail the new policy, and add focused tests for missing uppercase, lowercase, and number requirements.

## Assumptions

- Password complexity means at least one ASCII uppercase letter, one ASCII lowercase letter, and one ASCII digit.
- Validation should continue accumulating all applicable errors rather than failing fast.
- Existing email and minimum-length validation should keep their current behavior and ordering before new complexity errors.
- createSignupPayload does not need logic changes because it already returns accumulated validation errors.

## Files

- src/signup.mjs
- test/signup.test.mjs

## Steps

- In src/signup.mjs, add separate password checks after the existing minimum-length check for /[A-Z]/, /[a-z]/, and /[0-9]/.
- Use distinct error messages for each missing requirement, such as 'password must contain an uppercase letter', 'password must contain a lowercase letter', and 'password must contain a number'.
- Update the existing valid signup test password from 'correct horse' to a value satisfying all rules, such as 'Correct horse 1'.
- Update the existing invalid email plus short password test to keep it focused by using a short password that still has uppercase, lowercase, and number, such as 'Aa1xxxx'.
- Add targeted tests in test/signup.test.mjs for missing uppercase, missing lowercase, and missing number, each using a password that satisfies the other requirements.
- Assert exact error arrays to preserve deterministic ordering and message wording.
- Run npm test.

## Risks

- Existing exact deepEqual assertions will fail unless expected error arrays and fixtures are updated consistently.
- The current valid password fixture lacks uppercase and numeric characters, so it must change.
- ASCII-only regexes may be too narrow if product requirements expect Unicode letter or digit handling.
- This tightens behavior for any caller relying on length-only password validation.
- Symbol requirements are out of scope unless a human clarifies otherwise.

## Tests

- npm test

## Estimate

- Complexity: low

## Resolutions

- codex uniquely suggests tests: node --test.
  - Chosen: `synthesis`
  - Rationale: Use npm test as the canonical project command because package.json maps it directly to node --test; the direct command is valid but redundant for the candidate plan.
  - Evidence: `package.json`
- codex uniquely identifies risks: Unicode expectations, brittle exact error arrays, and ambiguous symbol requirements.
  - Chosen: `synthesis`
  - Rationale: Keep these risks because the repository has exact array assertions and no policy documentation expanding complexity beyond uppercase, lowercase, and number.
  - Evidence: `test/signup.test.mjs`, `src/signup.mjs`
- claude uniquely identifies risks: existing valid fixture breakage, exact error wording/order, behavior tightening, and ASCII-only limitations.
  - Chosen: `claude`
  - Rationale: These risks are concrete and verified: the current valid fixture is 'correct horse', and tests assert exact error arrays.
  - Evidence: `test/signup.test.mjs`, `src/signup.mjs`
- codex uniquely proposes steps: use regex complexity checks, include-style messages, update valid fixture to Correct123, keep short-password test focused, add targeted tests, and optionally assert createSignupPayload propagation.
  - Chosen: `synthesis`
  - Rationale: Include the focused short-password fixture update because it preserves the existing test intent; do not add extra createSignupPayload coverage beyond the existing propagation test unless implementation changes warrant it.
  - Evidence: `test/signup.test.mjs`, `src/signup.mjs`
- claude uniquely proposes steps: add checks after length, use contain-style messages, update valid fixture to Correct horse 1, add exact missing-requirement tests, optionally test multiple accumulated complexity errors, and run npm test.
  - Chosen: `synthesis`
  - Rationale: Use claude as the lead structure because it gives precise placement and exact targeted tests, but omit the optional multiple-error test to keep scope focused on the requested missing uppercase, lowercase, and number cases.
  - Evidence: `src/signup.mjs`, `test/signup.test.mjs`
- Confidence differs: codex: 90%, claude: 92%.
  - Chosen: `synthesis`
  - Rationale: The confidence difference is not material; repository evidence supports a merged plan using claude's specificity plus codex's focused short-password test adjustment.
  - Evidence: `src/signup.mjs`, `test/signup.test.mjs`, `package.json`

## Rejected Ideas

- `codex`: Run both node --test and npm test as required validation commands. - package.json shows npm test already runs node --test, so requiring both is redundant.
- `codex`: Add extra createSignupPayload assertions for each new complexity case. - Existing tests already cover createSignupPayload error propagation; targeted validateSignup tests are sufficient for the new validation rules.
- `claude`: Optionally assert multiple complexity errors accumulate. - Useful but not required by the task; exact targeted missing uppercase, lowercase, and number tests keep the change smaller.

## Open Questions For Human

- Should password complexity remain ASCII-only, or should Unicode uppercase, lowercase, and digit classes be supported?

## Approval

This is a candidate plan only. It is not approved automatically.

Approve this reconciled plan with: `codecouncil approve --session 20260702-170202-add-password-complexity-validation-and-tests-for --reconciled`
