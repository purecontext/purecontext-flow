# Review instructions — purecontext-flow

Read by `/crucible:review` from the base branch, never from a PR's own changes. It says what Important means in this repo, what to skip, and what a finding needs as evidence. Keep it short; a rule here is read on every review.

## What Important means here

Reserve Important for a finding that would break behavior this repo claims, corrupt or lose data, or open the local attack surface (a listener, a path from input, a spawn, outside content). Naming, shape and refactoring suggestions are Nit at most. A finding that holds the code to a stronger claim than its docs or the PR body make is a scope question for the user, not a severity.

Failure here is a wrong answer from the engine on a real workflow: a transition allowed that the graph forbids, a state file left torn or with fields lost, a trigger that fires or stays silent against what the README says, or a tool response a calling skill would misread. Every fleet repo runs this engine through forge-flow, so a change to a tool's input or output shape is a change to every skill that calls it.

## Cap the nits

Post at most five Nits per review, the most important first. The reviewer reports every Nit; the cut is made when the review is posted.

## Do not report

- Anything CI already enforces: lint, formatting, type errors
- Generated files (`dist/`) and lockfiles
- Test-only code that intentionally violates production rules

## Evidence

A behavior claim needs a file and line in the source, never an inference from a name. An absence claim ("no cleanup", "no guard") needs the enclosing scope read, not the hunk.

## Mutation testing

No mutation testing: no reverts, mutants, sweeps or survivor counts, in review or anywhere else.

## Always check

- A tool's schema description, the README tools table and the CHANGELOG say the same thing as the handler.
- State file writes go through `writeState` (atomic), and nothing is written on a refusal.
- A new or changed response field is covered by a test in `test/engine.test.mjs` or `test/server.test.mjs`.
