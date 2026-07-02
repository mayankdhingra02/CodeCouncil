# Plan Comparison

Session: `20260702-040811-add-password-complexity-validation-and-tests-for`

## Decision Policy

- Engine: local-rules
- Uses AI judge: no
- Human approval required: yes
- Model confidence score weight: 5%

CodeCouncil compared structured plan fields with deterministic local rules. It
did not call Codex, Claude, or another model to judge the plans.

## Agent Summaries

### Codex

Read-only plan to add password complexity validation for uppercase, lowercase,
and number requirements, plus focused tests for each missing requirement.

- Complexity: low
- Confidence: 92%

### Claude

Extend `validateSignup` in `src/signup.mjs` with three independent password
complexity checks and update/add tests in `test/signup.test.mjs`.

- Complexity: low
- Confidence: 92%

## Major Agreements

- Both agents produced structured plans.
- Both focused on `src/signup.mjs` and `test/signup.test.mjs`.
- Both recommended `npm test`.
- Both estimated low complexity.

## Major Disagreements

- Codex emphasized ambiguity around ASCII versus Unicode character classes.
- Codex suggested keeping the existing invalid email plus short password test
  focused by changing the sample password to one that is short but otherwise
  complexity-compliant.
- Claude emphasized the breaking behavior change for passwords that used to pass
  length-only validation.
- Claude proposed concrete regex checks and exact error text.
- Claude initially suggested expanding the existing short-password test with
  extra complexity errors, which the reconciled plan later rejected as less
  focused.

## Risk Areas

- Previously valid passwords without uppercase or numeric characters will now be
  rejected.
- Error ordering matters because tests assert exact arrays.
- ASCII-only validation may not match future Unicode password expectations.

## Recommended Approach

Use Claude as the lead implementation plan, then incorporate Codex's cleaner
test isolation idea and ASCII/Unicode risk note.
