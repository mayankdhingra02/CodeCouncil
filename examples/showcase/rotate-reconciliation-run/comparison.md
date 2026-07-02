# Deterministic Plan Comparison

Session: `20260702-170202-add-password-complexity-validation-and-tests-for`

## Decision Policy

- Engine: local rules
- Uses AI judge: no
- Human approval required: yes
- Model confidence score weight: 5%

CodeCouncil compared structured plan fields with deterministic local rules. It
did not call Codex, Claude, or another model to judge the plans.

## Agent Summaries

### Codex

Codex proposed adding password complexity checks in signup validation and
focused `node:test` coverage for missing uppercase, lowercase, and number
requirements.

- Complexity: low
- Confidence: 90%

### Claude

Claude proposed extending `validateSignup` in `src/signup.mjs` with independent
uppercase, lowercase, and number checks, then adding `node:test` cases in
`test/signup.test.mjs` for each missing requirement.

- Complexity: low
- Confidence: 92%

## Major Agreements

- Both agents produced structured plans.
- Both focused on `src/signup.mjs` and `test/signup.test.mjs`.
- Both included `npm test` or its equivalent as validation.
- Both estimated low complexity.

## Major Disagreements

- Codex listed `node --test` directly, while Claude used `npm test`.
- Codex emphasized keeping the short-password test focused by changing its
  fixture to a short password that still has uppercase, lowercase, and number.
- Claude emphasized exact check placement, exact error messages, and targeted
  tests for each missing requirement.
- Claude proposed an optional multiple-error accumulation test.
- The agents used slightly different wording for validation messages:
  `must include` versus `must contain`.

## Risk Areas

- Existing exact `deepEqual` assertions make error wording and ordering
  observable.
- The current valid password fixture lacks uppercase and numeric characters.
- The current short-password fixture could start failing for unrelated
  complexity reasons unless it is updated carefully.
- ASCII-only regexes may be too narrow if future requirements expect Unicode
  letter or digit handling.
- Tightening validation is a breaking behavior change for callers that relied on
  length-only passwords.
- Symbol requirements are unspecified and should stay out of scope unless the
  human asks for them.

## Security Considerations

- This is input validation work, so the implementation should keep collecting
  all applicable errors instead of failing fast.
- No secret files, auth files, deployment files, or payment-related files were
  involved.

## Local Quality Assessment

| Agent | Total | Completeness | Specificity | Risks | Tests | Scope | Confidence |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Codex | 76% | 100% | 67% | 42% | 70% | 100% | 90% |
| Claude | 78% | 100% | 76% | 46% | 60% | 100% | 92% |

## Suggested Merged Plan Skeleton

- Change `src/signup.mjs`.
- Change `test/signup.test.mjs`.
- Validate with `npm test`.
- Combine Claude's precise implementation/test placement with Codex's fixture
  isolation note for the existing short-password test.

## Recommended Approach

Use Claude as the lead implementation plan, then manually incorporate missing
fixture-isolation and risk coverage from Codex.

## Comparison Warning

This comparison is a briefing layer, not a final judge. Human approval or
reconciliation should happen before implementation.
