# `set_goal` patch design

Claude Code 2.1.201, 2.1.202, 2.1.205, and 2.1.206 already contain the full `/goal` runtime:
session-scoped Stop-hook registration, goal replacement, evaluator feedback, automatic
continuation, status counters, automatic clearing on success, transcript
markers, and restoration when a session resumes. The patch therefore exposes
that runtime as a model-callable tool instead of implementing a second goal
engine.

## Binary seams

The reviewed builds still contain the legacy `TodoWrite` tool, but its
`isEnabled()` returns false while the newer Task tools are enabled. The support
pack makes two exact, fail-closed replacements:

1. Rename the unique `TodoWrite` tool-name binding to lowercase `set_goal`.
2. Replace the complete dormant `TodoWrite` definition with a smaller tool
   definition whose `call()` validates one `objective` string and delegates to
   Claude Code's existing internal goal setter (`ICt` in 2.1.201, `KCt` in
   2.1.202, `Fnr` in 2.1.205, and `Fnr` in 2.1.206).

The replacement initializes the version-specific goal module (`aJe`, `EJe`, or
`Jkt`)
before calling it. It does
not patch the evaluator, Stop-hook dispatcher, persistence format, transcript
format, status UI, or `/goal` command. The support pack remains bound to the
exact stock SHA-256 and requires each original byte sequence exactly once.

## Tool contract

```json
{
  "name": "set_goal",
  "input": {
    "objective": "A measurable condition, including the evidence that proves it"
  }
}
```

The objective is trimmed and limited to the same 4,000 characters as `/goal`.
Calling the tool replaces an active goal. The tool is always loaded, does not
ask for filesystem or shell permission, and returns the normalized active
objective. Goal execution still honors the session's normal permission mode.

The existing `/goal clear` command remains the early-cancellation path. A goal
that is met is cleared by Claude Code's evaluator, and an active goal is
restored by the existing resume path.

## Verification gates

- Recipe construction proves both source seams are unique and replacements fit
  in-place.
- Support-pack application proves the stock hash, size, recipe cardinality,
  final unsigned runtime hash, and absence of original bytes.
- The patched executable must pass ad-hoc signing and `codesign --verify`.
- A live isolated `claude-all` smoke test must observe a `set_goal` tool call,
  an active `/goal` status, at least one evaluator decision, and automatic
  clearing after a trivially provable condition is surfaced.
- Resume verification must show that an unmet goal is restored without adding
  a second Stop hook.

This feature is intentionally limited to exact reviewed builds. Each later
support pack must independently identify both the dormant-tool seam and the
native goal setter.

## Upstream references

- [Keep Claude working toward a goal](https://code.claude.com/docs/en/goal)
- [Hooks reference: Stop](https://code.claude.com/docs/en/hooks#stop)
