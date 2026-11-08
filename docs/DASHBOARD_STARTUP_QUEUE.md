# Queued: persistent dashboard and one-click launch

Requested 7 November 2026 during final onboarding verification.

- Keep the local admin dashboard available while the bot is running. Remove routine session timeout interruptions for this local workflow; reconnect cleanly after temporary connection loss.
- Provide one Windows `.bat` launcher that checks the supported runtime and required local services, starts the bot/dashboard, and opens the default browser.
- Authenticate through the launcher's automatic local handoff so the organizer does not enter a token into a field. Retain loopback access and credential protection.
- Deduplicate repeated launches: detect the existing owned bot/dashboard, reuse it, and avoid duplicate processes or browser tabs. Identify the actual application before treating a busy port as its existing instance.
- Define clear behavior for closing the browser, stopping the bot and restarting the computer; a continuously available dashboard does not imply silently installing a Windows service.
- Verify repeated/double-click launch, existing instance, browser closed, database unavailable, reconnect and explicit shutdown.

Current guided startup already opens an authenticated browser link automatically. Persistent sessions and the deduplicated `.bat` launcher remain queued; the existing session expiry policy is still active until this follow-up is implemented.
