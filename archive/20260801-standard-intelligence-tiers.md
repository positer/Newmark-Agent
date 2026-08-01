# Standard intelligence tiers

Date: 2026-08-01

## Change

Newmark now uses the same five intelligence labels throughout its shared state and presentation surfaces: `low`, `medium`, `high`, `xhigh`, and `max`.

- TUI Model renders reasoning effort as its first selectable column and deployments as the second.
- GUI Models owns the equivalent five-option selector instead of leaving it in an unrelated settings surface.
- The choice is stored as user-level `models.default_intelligence`, restored by a new Agent process, and propagated to already-resident conversation runners.
- OpenAI-compatible Chat Completions receives `reasoning_effort`.
- OpenAI Responses receives `reasoning.effort` and `reasoning.summary=auto`.
- Models without a recognized reasoning capability omit the reasoning field.
- Official OpenAI endpoints map compatibility-only `max` to the documented `xhigh`; custom compatible gateways receive literal `max`.

## Verification

- Dedicated request capture: 502 requests.
- Stress matrix: 50 rounds x 5 tiers x 2 protocols = 500 protocol requests.
- Additional checks cover non-reasoning omission and official endpoint normalization.
- Each tier was saved and restored through a fresh Agent instance.
- TUI switching stress performs 250 tier changes and the focused suite passes 53/53.
- The complete source release gate exited 0 in 307.5 seconds, including SSH and WSL PTY gates, CLI contracts, and GUI/TUI/CLI shared-backend stress.
