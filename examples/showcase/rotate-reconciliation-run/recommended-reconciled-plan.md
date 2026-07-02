# Recommended Reconciled Plan

Session: `20260702-170202-add-password-complexity-validation-and-tests-for`
Reconciler: `codex` (OpenAI Codex CLI)
Confidence: 86%

## Bias Disclosure

The reconciler also produced one of the source plans, so this reconciliation may
contain model self-preference bias.

## Bias Metrics

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

## Summary

Add three independent password complexity checks to signup validation, update
existing fixtures that would fail the new policy, and add focused tests for
missing uppercase, lowercase, and number requirements.

## Assumptions

- Password complexity means at least one ASCII uppercase letter, one ASCII
  lowercase letter, and one ASCII digit.
- Validation should continue accumulating all applicable errors rather than
  failing fast.
- Existing email and minimum-length validation should keep their current
  behavior and ordering before new complexity errors.
- `createSignupPayload` does not need logic changes because it already returns
  accumulated validation errors.

## Files

- `src/signup.mjs`
- `test/signup.test.mjs`

## Steps

- In `src/signup.mjs`, add separate password checks after the existing
  minimum-length check for `/[A-Z]/`, `/[a-z]/`, and `/[0-9]/`.
- Use distinct error messages for each missing requirement, such as
  `password must contain an uppercase letter`,
  `password must contain a lowercase letter`, and
  `password must contain a number`.
- Update the existing valid signup test password from `correct horse` to a value
  satisfying all rules, such as `Correct horse 1`.
- Update the existing invalid email plus short password test to keep it focused
  by using a short password that still has uppercase, lowercase, and number,
  such as `Aa1xxxx`.
- Add targeted tests in `test/signup.test.mjs` for missing uppercase, missing
  lowercase, and missing number, each using a password that satisfies the other
  requirements.
- Assert exact error arrays to preserve deterministic ordering and message
  wording.
- Run `npm test`.

## Risks

- Existing exact `deepEqual` assertions will fail unless expected error arrays
  and fixtures are updated consistently.
- The current valid password fixture lacks uppercase and numeric characters, so
  it must change.
- ASCII-only regexes may be too narrow if product requirements expect Unicode
  letter or digit handling.
- This tightens behavior for any caller relying on length-only password
  validation.
- Symbol requirements are out of scope unless a human clarifies otherwise.

## Resolution Highlights

- Treated `npm test` as canonical because `package.json` maps it to
  `node --test`.
- Kept both agents' risk notes about exact error arrays and ASCII-only matching.
- Selected Claude's concrete fixture-breakage risk as directly verified.
- Adopted Codex's short-password fixture isolation idea.
- Rejected extra `createSignupPayload` assertions for each new complexity case
  because existing tests already cover propagation.
- Rejected the optional multiple-error accumulation test to keep the change
  focused on the requested cases.

## Open Question For Human

Should password complexity remain ASCII-only, or should Unicode uppercase,
lowercase, and digit classes be supported?

## Approval

This is a candidate plan only. It is not approved automatically.
