# 2026-08-22 Mobile Alarm Tool and Release Cleanup

## Changes

- Added `alarm_manage` to the mobile local Agent tool catalog and schema.
- Implemented `AlarmTool` with Android `AlarmManager`, exact/non-exact scheduling, private alarm records, cancellation, and notification receiver.
- Declared `android.permission.SCHEDULE_EXACT_ALARM`; exact-alarm denial opens the system special-access page and fails closed.
- Added ChatViewModel/NewmarkApp binding for the tool.

## Verification

- `android\\gradlew.bat testDebugUnitTest lintVitalRelease assembleRelease` passed.
- Six final `0.5.4` assets are in the repository `release` directory.
- Temporary `newmark-release-0.5.4` output was removed. A failed Desktop staging directory remains at `release-0.5.4/win-unpacked.tmp` because `default_app.asar` was still held by an external Windows process; it was not force-deleted.
