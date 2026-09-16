---
name: tdd
description: 'Test-driven development via the red-green-refactor loop: write a failing test, watch it fail, write minimal code to pass, repeat. Use whenever implementing a feature, changing behavior, or fixing a bug, not only when the user explicitly says "TDD". Drive the whole loop yourself by default, without waiting for permission to start. Also triggers on "red-green-refactor", test-first, or integration-test requests. Skip only for pure exploration, code reading/explanation, docs, logic-free config/dependency edits, and one-off scripts that will not be committed or reused.'
---

# Test-Driven Development

TDD is the red → green loop. This skill is the reference that makes that loop produce tests worth keeping: what a good test is, where tests go, the anti-patterns, and the rules of the loop. Every section applies on every cycle: consult them before and during the loop, not after.

When exploring the codebase, read `CONTEXT.md` (if it exists) so test names and interface vocabulary match the project's domain language, and respect ADRs in the area you're touching.

## What a good test is

Tests verify behavior through public interfaces, not implementation details. Code can change entirely; tests shouldn't. A good test reads like a specification: "user can checkout with valid cart" tells you exactly what capability exists, and it survives refactors because it doesn't care about internal structure.

See [tests.md](tests.md) for examples and [mocking.md](mocking.md) for mocking guidelines.

## Seams: where tests go

A **seam** is the public boundary you test at: the interface where you observe behavior without reaching inside. Tests live at seams, never against internals.

**Test only at seams you have stated.** Before writing any test, name the seams under test and state them in one line as you start, so the user can redirect. Don't wait for sign-off. You can't test everything, so choosing the seams deliberately is how testing effort lands on the critical paths and complex logic instead of every edge case.

Ask yourself: "What's the public interface, and which seams should we test?" Ask the user a single focused question only when several reasonable interface shapes compete and you can't pick; otherwise state your choice and proceed.

When the shape of that interface is itself in question (how deep the module is, where the seam belongs, what the interface should expose), call the `skill` tool with "codebase-design" for the vocabulary. It is the shared source of the module, interface, depth, seam, adapter, leverage and locality terms, and it is a reference to consult, not a session to run.

## Anti-patterns

- **Implementation-coupled**: mocks internal collaborators, tests private methods, or verifies through a side channel (querying the database instead of using the interface). The tell: the test breaks when you refactor but behavior hasn't changed.
- **Tautological**: the assertion recomputes the expected value the way the code does (`expect(add(a, b)).toBe(a + b)`, a snapshot derived by hand the same way, a constant asserted equal to itself), so it passes by construction and can never disagree with the code. Expected values must come from an independent source of truth: a known-good literal, a worked example, the spec.
- **Horizontal slicing**: writing all tests first, then all implementation. Bulk tests verify _imagined_ behavior: you test the _shape_ of things rather than user-facing behavior, the tests go insensitive to real changes, and you commit to test structure before understanding the implementation. Work in **vertical slices** instead: one test → one implementation → repeat, each test a **tracer bullet** that responds to what the last cycle taught you.

## Rules of the loop

- **Red before green.** Write the failing test first, then only enough code to pass it. Don't anticipate future tests or add speculative features.
- **One slice at a time.** One seam, one test, one minimal implementation per cycle.
- **Run every red and every green.** A red you didn't observe isn't red: the failure message is what confirms the test exercises the path you think it does.
- **Refactoring is not part of the loop.** It belongs to the review stage, not the red → green implementation cycle.
