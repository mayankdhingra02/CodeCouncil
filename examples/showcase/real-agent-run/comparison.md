# Plan Comparison

## Decision Policy

- Engine: local-rules
- Uses AI judge: no
- Human approval required: yes
- Model confidence score weight: 5%
- CodeCouncil compares structured plan fields with deterministic local rules. It does not call Codex, Claude, or another model to judge the plans.

Research basis:
- Execution-based software engineering benchmarks value runnable validation over model confidence.
- Patch-generation systems separate localization, repair planning, and patch validation.
- LLM-judge literature favors explicit rubrics and pairwise evidence, while warning about judge bias.

## Agent Summaries

### codex

Add password complexity checks in signup validation and focused node:test coverage for missing uppercase, lowercase, and number requirements. No files were edited.

- Complexity: low
- Confidence: 90%

### claude

Extend validateSignup in src/signup.mjs with three independent password complexity checks (uppercase, lowercase, number), each pushing a distinct error message, and add node:test cases in test/signup.test.mjs covering each missing requirement; update the existing valid-signup test whose password would now fail.

- Complexity: low
- Confidence: 92%

## Major Agreements

- All selected agents produced structured plans.
- Shared file/area focus: src/signup.mjs, test/signup.test.mjs.
- Shared testing strategy: npm test.
- All agents estimate low complexity.

## Major Disagreements

- codex uniquely suggests tests: node --test.
- codex uniquely identifies risks: If product requirements expect Unicode letter classes instead of ASCII A-Z/a-z, simple regexes would be too narrow., Existing tests with exact error arrays will need careful updates to avoid brittle failures from changed error ordering., Ambiguous password policy details, such as whether symbols are required, are not covered by this task..
- claude uniquely identifies risks: The existing valid-signup test breaks unless its password is updated, since 'correct horse' has no uppercase letter or digit., Tests use assert.deepEqual on the full errors array, so error message wording and ordering must match exactly between implementation and tests., Tightening validation is a breaking change for any real callers relying on length-only rules (low impact in this demo repo)., ASCII-only regexes reject passwords using non-Latin letters; acceptable here but worth noting..
- codex uniquely proposes steps: Update validateSignup in src/signup.mjs to check password with /[A-Z]/, /[a-z]/, and /\d/., Add clear error messages such as 'password must include an uppercase letter', 'password must include a lowercase letter', and 'password must include a number'., Update the existing valid signup fixture from 'correct horse' to a password that satisfies all rules, such as 'Correct123'., Keep the existing short-password test focused by using a short password that still contains uppercase, lowercase, and number, such as 'Aa1xxxx'., Add targeted tests for passwords missing uppercase, missing lowercase, and missing number., Assert both validateSignup behavior and, where useful, createSignupPayload response status/error propagation..
- claude uniquely proposes steps: In validateSignup (src/signup.mjs), after the length check, add: if (!/[A-Z]/.test(password)) push 'password must contain an uppercase letter'., Add: if (!/[a-z]/.test(password)) push 'password must contain a lowercase letter'., Add: if (!/[0-9]/.test(password)) push 'password must contain a number'., Update the existing 'accepts a valid signup' test to use a password satisfying all rules (e.g. 'Correct horse 1')., Add a test for missing uppercase (e.g. 'lowercase1234') asserting exactly the uppercase error., Add a test for missing lowercase (e.g. 'UPPERCASE1234') asserting exactly the lowercase error., Add a test for missing number (e.g. 'NoNumbersHere') asserting exactly the number error., Optionally assert that multiple complexity errors accumulate (e.g. all-lowercase, no-digit password)., Run npm test and confirm all tests pass..
- Confidence differs: codex: 90%, claude: 92%.

## Risk Areas

- If product requirements expect Unicode letter classes instead of ASCII A-Z/a-z, simple regexes would be too narrow.
- Existing tests with exact error arrays will need careful updates to avoid brittle failures from changed error ordering.
- Ambiguous password policy details, such as whether symbols are required, are not covered by this task.
- The existing valid-signup test breaks unless its password is updated, since 'correct horse' has no uppercase letter or digit.
- Tests use assert.deepEqual on the full errors array, so error message wording and ordering must match exactly between implementation and tests.
- Tightening validation is a breaking change for any real callers relying on length-only rules (low impact in this demo repo).
- ASCII-only regexes reject passwords using non-Latin letters; acceptable here but worth noting.

## Security Considerations

- codex assumption: Input validation or output encoding - Validation should continue collecting all applicable errors instead of failing fast.
- codex summary: Input validation or output encoding - Add password complexity checks in signup validation and focused node:test coverage for missing uppercase, lowercase, and number requirements. No files were edited.
- claude risk: Input validation or output encoding - Tightening validation is a breaking change for any real callers relying on length-only rules (low impact in this demo repo).

## Missing Considerations

- None

## Local Quality Assessment

| Agent | Total | Rubric | Completeness | Specificity | Risks | Tests | Scope | Confidence |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| codex | 76% | 76% | 100% | 67% | 42% | 70% | 100% | 90% |
| claude | 78% | 77% | 100% | 76% | 46% | 60% | 100% | 92% |

### codex Assessment

Strengths:
- Provides most expected structured planning fields.
- Covers every local comparison rubric dimension at least partially.
- Aligns with another agent on at least one file.
- Aligns with another agent on at least one test command.

Weaknesses:
- Risk coverage is thin.

Rubric:
- Task Understanding: strong (100%)
- Repository Localization: strong (75%)
- Implementation Steps: partial (69%)
- Validation Strategy: strong (80%)
- Risk And Safety: partial (49%)
- Reviewability: strong (100%)
- Scope Control: strong (100%)

### claude Assessment

Strengths:
- Provides most expected structured planning fields.
- Names concrete files and implementation steps.
- Covers every local comparison rubric dimension at least partially.
- Aligns with another agent on at least one file.
- Aligns with another agent on at least one test command.

Weaknesses:
- Risk coverage is thin.

Rubric:
- Task Understanding: strong (100%)
- Repository Localization: strong (75%)
- Implementation Steps: strong (81%)
- Validation Strategy: partial (73%)
- Risk And Safety: partial (52%)
- Reviewability: strong (100%)
- Scope Control: strong (100%)

## Suggested Merged Plan Skeleton

## Common Core

- Change or inspect src/signup.mjs.
- Change or inspect test/signup.test.mjs.
- Validate with npm test.

## Unique Contributions By Agent

### codex

- Unique step: Update validateSignup in src/signup.mjs to check password with /[A-Z]/, /[a-z]/, and /\d/..
- Unique step: Add clear error messages such as 'password must include an uppercase letter', 'password must include a lowercase letter', and 'password must include a number'..
- Unique step: Update the existing valid signup fixture from 'correct horse' to a password that satisfies all rules, such as 'Correct123'..
- Unique step: Keep the existing short-password test focused by using a short password that still contains uppercase, lowercase, and number, such as 'Aa1xxxx'..
- Unique step: Add targeted tests for passwords missing uppercase, missing lowercase, and missing number..
- Unique step: Assert both validateSignup behavior and, where useful, createSignupPayload response status/error propagation..
- Unique validation: node --test.
- Unique risk: If product requirements expect Unicode letter classes instead of ASCII A-Z/a-z, simple regexes would be too narrow..
- Unique risk: Existing tests with exact error arrays will need careful updates to avoid brittle failures from changed error ordering..
- Unique risk: Ambiguous password policy details, such as whether symbols are required, are not covered by this task..

### claude

- Unique step: In validateSignup (src/signup.mjs), after the length check, add: if (!/[A-Z]/.test(password)) push 'password must contain an uppercase letter'..
- Unique step: Add: if (!/[a-z]/.test(password)) push 'password must contain a lowercase letter'..
- Unique step: Add: if (!/[0-9]/.test(password)) push 'password must contain a number'..
- Unique step: Update the existing 'accepts a valid signup' test to use a password satisfying all rules (e.g. 'Correct horse 1')..
- Unique step: Add a test for missing uppercase (e.g. 'lowercase1234') asserting exactly the uppercase error..
- Unique step: Add a test for missing lowercase (e.g. 'UPPERCASE1234') asserting exactly the lowercase error..
- Unique step: Add a test for missing number (e.g. 'NoNumbersHere') asserting exactly the number error..
- Unique step: Optionally assert that multiple complexity errors accumulate (e.g. all-lowercase, no-digit password)..
- Unique step: Run npm test and confirm all tests pass..
- Unique risk: The existing valid-signup test breaks unless its password is updated, since 'correct horse' has no uppercase letter or digit..
- Unique risk: Tests use assert.deepEqual on the full errors array, so error message wording and ordering must match exactly between implementation and tests..
- Unique risk: Tightening validation is a breaking change for any real callers relying on length-only rules (low impact in this demo repo)..
- Unique risk: ASCII-only regexes reject passwords using non-Latin letters; acceptable here but worth noting..

## Open Questions

- None

## Suggested Merged Steps

- Change or inspect src/signup.mjs.
- Change or inspect test/signup.test.mjs.
- Validate with npm test.
- Consider codex's unique contributions: Unique step: Update validateSignup in src/signup.mjs to check password with /[A-Z]/, /[a-z]/, and /\d/.. Unique step: Add clear error messages such as 'password must include an uppercase letter', 'password must include a lowercase letter', and 'password must include a number'.. Unique step: Update the existing valid signup fixture from 'correct horse' to a password that satisfies all rules, such as 'Correct123'.. Unique step: Keep the existing short-password test focused by using a short password that still contains uppercase, lowercase, and number, such as 'Aa1xxxx'.. Unique step: Add targeted tests for passwords missing uppercase, missing lowercase, and missing number.. Unique step: Assert both validateSignup behavior and, where useful, createSignupPayload response status/error propagation.. Unique validation: node --test. Unique risk: If product requirements expect Unicode letter classes instead of ASCII A-Z/a-z, simple regexes would be too narrow.. Unique risk: Existing tests with exact error arrays will need careful updates to avoid brittle failures from changed error ordering.. Unique risk: Ambiguous password policy details, such as whether symbols are required, are not covered by this task..
- Consider claude's unique contributions: Unique step: In validateSignup (src/signup.mjs), after the length check, add: if (!/[A-Z]/.test(password)) push 'password must contain an uppercase letter'.. Unique step: Add: if (!/[a-z]/.test(password)) push 'password must contain a lowercase letter'.. Unique step: Add: if (!/[0-9]/.test(password)) push 'password must contain a number'.. Unique step: Update the existing 'accepts a valid signup' test to use a password satisfying all rules (e.g. 'Correct horse 1').. Unique step: Add a test for missing uppercase (e.g. 'lowercase1234') asserting exactly the uppercase error.. Unique step: Add a test for missing lowercase (e.g. 'UPPERCASE1234') asserting exactly the lowercase error.. Unique step: Add a test for missing number (e.g. 'NoNumbersHere') asserting exactly the number error.. Unique step: Optionally assert that multiple complexity errors accumulate (e.g. all-lowercase, no-digit password).. Unique step: Run npm test and confirm all tests pass.. Unique risk: The existing valid-signup test breaks unless its password is updated, since 'correct horse' has no uppercase letter or digit.. Unique risk: Tests use assert.deepEqual on the full errors array, so error message wording and ordering must match exactly between implementation and tests.. Unique risk: Tightening validation is a breaking change for any real callers relying on length-only rules (low impact in this demo repo).. Unique risk: ASCII-only regexes reject passwords using non-Latin letters; acceptable here but worth noting..
- Approve the merged common core, then implement in an isolated worktree.

## Recommendation Evidence

- claude has the highest local rules score (78%).
- Score uses a local rubric for task understanding, localization, implementation steps, validation, risk/safety, reviewability, scope control, and only 5% self-reported confidence.
- Rubric score before confidence adjustment: 77%.
- Strengths: Provides most expected structured planning fields.; Names concrete files and implementation steps.; Covers every local comparison rubric dimension at least partially.; Aligns with another agent on at least one file.; Aligns with another agent on at least one test command..
- Agents agree on these files/areas: src/signup.mjs, test/signup.test.mjs.
- Agents agree on these tests: npm test.
- Model confidence is high, but CodeCouncil treats it as a small signal only.

## Comparison Warnings

- Local comparison is a briefing layer, not a final judge. Use reconcile/cross-review or human approval before implementation.

## Recommended Approach

Use claude as the lead implementation plan, then manually incorporate any missing risk or testing coverage from the other plan(s).

## Suggested Implementation Agent

claude
