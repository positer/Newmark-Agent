# Newmark Agent dev-0.5.14

## Highlights

- Windows same-version MSI update no longer leaves an installation transaction that breaks GUI/TUI after restart; the update path terminates only Newmark processes in the target install directory, removes stale rename/delete entries for that directory, and keeps user state in the independent `.Newmark` runtime root.
- PC first-response title generation is now completed before the first formal Agent response, while the mobile side keeps the same ordering.
- Guide and queue timeline ordering is shared between PC and mobile, including mobile visibility of PC queued messages, position-preserving Guide injection, and real-time avoidance with midpoint landing for drag reordering.
- Advanced `web_catch` is available for local PC/Android Build and Goal workflows: it can save public web downloads, whole pages, or selected component assets to an exact workspace path; Plan/Chat cannot access it. PC exposes the full schema through `tool_provision`; Android exposes it directly and does not use `tool_provision`.
- Agent and web traffic now use the same proxy configuration (`proxy.enabled/url/auth` or `HTTPS_PROXY`/`HTTP_PROXY`). Android accepts `TRANSPORT_VPN` and does not wait for a stale `VALIDATED` snapshot when a VPN/proxy route is already usable.
- `web_search` reports "searched the web"; `web_fetch` and `web_catch` report "fetched the web".
- `image_display` evidence now appears before the final Agent reply text, in presentation order, on PC GUI, PC TUI, and Android, while the Build tool activity still keeps the original image surfaces.

## Verification

- Desktop: typecheck, build, and full release gate include `1708/1708` primary assertions; additional tool provisioning, launcher, queue/Guide, and cross-client stress gates pass.
- Android: JVM unit suite, Vital lint, R8/minify, and release assembly pass.
- Visual/position stress: 24 interleaved `image_display` images render in order inside the Build and in front of the final reply on PC GUI and TUI; Android projection contract passes.
- Windows, Linux, and Android artifacts are prerelease builds. Windows executables are not Authenticode-signed; the Android APK uses the project's existing Android Debug certificate and is intended for development/sideloading.
