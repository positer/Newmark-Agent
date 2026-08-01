# 2026-08-01 TUI image focus action hint

TUI Build image rows now use progressive disclosure. Unfocused rows render only `[示意图]`, without the image title or action hint. When history navigation places the cursor on that exact image, the row extends with its image description and `· Enter 打开`; moving away hides both. The selected layout reserves the suffix width and truncates only the title when necessary, keeping the action visible on narrow terminals.

Regression coverage asserts the hint is absent before focus, appears exactly once on the focused image, still opens the dedicated viewer with Enter, disappears after focus returns to the Build header, and preserves expanded/collapsed insertion ordering.

Displayed titles are also content-aware. If the active model has validated vision input, Newmark sends the actual hydrated image to that provider and uses its concise visual description as the GUI/TUI title. Caption text becomes a hint/fallback, descriptions are cached by deployment and image hash, and model failure does not block display.
