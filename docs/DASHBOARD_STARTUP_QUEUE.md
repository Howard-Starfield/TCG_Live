# Implemented: persistent dashboard and one-click launch

Requested 7 November 2026 during final onboarding verification.

- Keep the local admin dashboard available while the bot is running. Remove routine session timeout interruptions for this local workflow; reconnect cleanly after temporary connection loss.
- Provide one Windows `.bat` launcher that checks the supported runtime and required local services, starts the bot/dashboard, and opens the default browser.
- Authenticate through the launcher's automatic local handoff so the organizer does not enter a token into a field. Retain loopback access and credential protection.
- Deduplicate repeated launches: detect the existing owned bot/dashboard, reuse it, and avoid duplicate processes or browser tabs. Identify the actual application before treating a busy port as its existing instance.
- Define clear behavior for closing the browser, stopping the bot and restarting the computer; a continuously available dashboard does not imply silently installing a Windows service.
- Verify repeated/double-click launch, existing instance, browser closed, database unavailable, reconnect and explicit shutdown.

Implemented and verified 7–8 November 2026. Double-click `Start TCG Live.bat`, or use `npm start`. Guided sessions have no routine expiry; direct-command/demo sessions retain their timed policy. The actual Windows launch and repeated-launch reuse were verified, along with safe stale-owner recovery. Native browser-closed reopening and an overnight idle check remain useful manual return tests; automated cases cover the corresponding session/opening rules. See [the validation record](LAUNCHER_ARTWORK_VALIDATION.md).
