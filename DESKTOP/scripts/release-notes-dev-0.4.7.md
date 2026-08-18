# Newmark Agent dev-0.4.7

This is an unsigned cross-platform prerelease.

## Tool availability and provisioning

- The first model turn receives complete schemas for the eight foundational workspace tools: `bash`, `pwd`, `read`, `write`, `edit`, `delete_file`, `glob`, and `grep`.
- Advanced tools—including SubAgent, task tools, Git/GitHub, Browser, Computer Use, skills, MCP, Automation, Flow, Memory Lab, and context management—are advertised through a compact capability catalog and loaded through `tool_provision` on demand.
- The system prompt explicitly states that advanced capability presence is not immediate callability and requires a dedicated provisioning subturn.
- Tool provisioning preserves the original schema and does not bypass Plan mode, SubAgent sandboxing, native-tool settings, deletion safety, or remote-write review.

## Desktop and orchestration reliability

- Removes the renderer GPU/input freeze caused by continuously animated masked borders and unbounded Build DOM refreshes.
- Coalesces high-frequency Build/SubAgent updates while keeping terminal events immediate.
- Keeps the public child creation tool named `SubAgent`, separates task checklist operations, binds monitoring entries one-to-one to real child identities, and displays the caller-supplied SubAgent name.
- Enforces per-running-Build SubAgent limits: 16 for Ultra and 4 for other intelligence tiers; excess creation requests terminate without creating records.

## Mobile work completed in the same source snapshot

- Extends the Android conversation, right-sidebar, branch, WorkRun projection, remote/local Agent, session-gate, stress, and pairing paths recorded in the repository maintenance ledger.

## Packages

- Windows x64 MSI and win-unpacked ZIP.
- Linux x64 AppImage, deb, and linux-unpacked ZIP.

## SHA-256

- `Newmark-Agent-0.4.7-x64.msi` — `FD46F635839626693F69D306A05547158BA5EAB0EA78045AC6356B90BE339417`
- `Newmark-Agent-0.4.7-win-unpacked-x64.zip` — `1814F9E5312E08D70BE6478B7418018482DA12A53C5E1434D5EE4BD9C054D9C8`
- `Newmark-Agent-0.4.7-x86_64.AppImage` — `B5E9E16EDA8DC8D08A594D789C3BE1E21C6310504F834155544B02112EE0BB7B`
- `Newmark-Agent-0.4.7-amd64.deb` — `39388636D30F7A918C449AC0E714F6B9B42835D6867B76B62D82E62C33093817`
- `Newmark-Agent-0.4.7-linux-unpacked-x64.zip` — `32831EEFF57FAEFCB5768F8B9918DDCF2A7ED127D09BCC8992DD034B8E0D3845`

The packaged and installed Windows `app.asar` SHA-256 is `CE962FA83BE0CD35526317927C239B55249AB7AA4FF03AC556BC6CD29F96BB5C`.
