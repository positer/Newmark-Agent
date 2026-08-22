# Newmark Agent dev-0.5.4

`dev-0.5.4` adds bounded Android privilege, local file/application inspection, plugin controls, and cross-platform final visual recovery.

## Highlights

- Android high-privilege mode is explicitly gated by a warning and keeps Root, Shizuku, and ADB capability domains separate.
- Android normal mode adds bounded shared-storage file management, public application inspection, local Skill/MCP settings, and expanded Termux command coverage.
- PC and Android use a final `mini OCR + text-only LLM correction` fallback when visual input is rejected and the provider has no usable alternate vision model.
- Android local conversations can attach bounded PNG/JPEG images directly to user messages; Chat Completions and Responses API payloads use standard image content parts.

## Safety

- Privileged tools are capability-checked again at execution time and are disabled after high-privilege mode exits.
- Image attachments are limited to PNG/JPEG, 12 MiB per image, and four images per local message.
- OCR output remains approximate, preserves uncertainty, and never fabricates unreadable visual content.

This is a prerelease development build. Review the platform-specific permissions and privilege warnings before enabling them.
