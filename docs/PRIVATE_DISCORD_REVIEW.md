# Private Discord plan review

Claude Opus 5.5 inspected the initial plan at high effort through the installed Claude CLI. The returned model identifier was `claude-opus-5-5`. It considered the plan sound and ready for offline coding after amendments. The primary agent evaluated the findings against the existing code and revised [the plan](PRIVATE_DISCORD_PLAN.md). This is plan inspection, not implementation or live Discord validation.

| Finding | Primary evaluation and disposition |
| --- | --- |
| Restart and retirement needed exact rules | Partly accepted. The review hypothesized that pause/expiry might retain runner ownership; existing code already clears it and persists an explicit expired phase. Preserve that behavior. Define local `prepare --replace`, preserve retired history, and block a new process when a match is still persisted as running. |
| Expiry and admin actions needed explicit semantics | Added the state/action table and slash options. Declined the suggested blanket clearing of judge attention on any admin action: refreshing a card or resuming play does not resolve an outstanding issue. Preserve existing finalization/resolve/correct clearing. Early deadline callbacks must reschedule. |
| Retirement could race a waiting command | Accepted. Retirement and commands share the aggregate row lock; active status and binding are checked inside the locked transaction. Namespace Discord/system command IDs and sample real time after lock acquisition. |
| Delivery tracking and repair were too elaborate | Accepted the simplification: persist three canonical message IDs, keep refresh state in memory, and refresh all known cards on startup/reconnect. Explicit repair may leave an inert stray card for manual removal. Keep no automatic retries of ambiguous sends and no replacement loop for permission errors. |
| Advisory-lock loss should stop the process | Accepted bounded fail-stop behavior, with a fixed redacted error rather than raw error logging. This avoids another degraded runtime mode. |
| Old report buttons could silently create a counterproposal | Accepted explicitly. I won/I lost carries its rendered expected revision, including zero. The adapter must not fill it from the latest state. Existing domain revision checks remain authoritative. |

The reviewer also proposed separate approval for each outward-facing step. That is not adopted as a standing workflow rule: one explicit authorization covering registration and test messages in the named private target is enough. The current request remains planning only.

The primary evaluation additionally makes the test clock boundary explicit: a living process keeps counting through a Gateway reconnect; a new process cannot resume a persisted running clock. This is a supervised practice constraint, not a decision on competitive outage policy. To make the simplified delivery model consistent after crashes, only an explicit admin refresh creates or replaces cards; startup and background work edit known IDs. Ordinary refresh does not repeat judge mentions.

The resulting scope is one private channel, four players and one test admin, three cards, the existing transactional match rules, one Gateway client, and a small refresh/timer loop. Credentials and real participant accounts are needed for the live gate, not for writing or testing the adapter offline. No second Opus inspection of the revised text has been run.

During implementation, primary review aligned the ownership lock with the database-wide single-active-session constraint and disabled the SDK's own ambiguous POST retries. It also corrected post-commit error reporting, timer retry/reconciliation, pin repair, and shutdown during acknowledgment. [The validation record](PRIVATE_DISCORD_VALIDATION.md) distinguishes tested native database behavior, simulated Discord transport, and the outstanding live gate. Opus did not inspect this implementation.

## Voice-chat and sticky-panel follow-up

The user subsequently required assigned voice-chat match panels and the sticky behavior from `Discord_PokeBuilder`. Luna inspected `cogs/utility.py`: the reference uses a human-message trigger, a per-channel lock and four-second cooldown, then deletes and reposts a static builder panel. It does not implement tournament signup. Its delete-before-send ordering and swallowed cleanup errors were not carried over.

Claude Opus 5.5 reviewed the follow-up plan at high effort before sticky implementation (`claude-opus-5-5`, one review turn). The primary accepted canonical-ID compare-and-set, durable suspension across crashes, bot-loop prevention, bounded cooldown/debounce, and explicit disabled-control explanations. The suggestion to build a durable nonce/retry mechanism was declined: this adapter already disables SDK POST retries and suspends uncertain sends rather than repeating them.

The resulting replacement order is send once, save the canonical binding under the existing aggregate lock, then delete only the old bot-authored panel. A reservation in the existing session JSON suspends the slot before a POST and is cleared after successful cleanup. No schema migration or general delivery queue was introduced. Sticky work shares the existing refresh queue so a concurrent match action cannot leave the replacement permanently showing old state. Human-only triggers follow the reference behavior and avoid loops with other bots or webhooks.

A live probe confirmed that the bot can delete its own pin notice when its type and referenced message ID match the newly pinned check-in. This preserves check-in pinning without leaving the notice below the sticky panel. Match voice-chat panels are not pinned because live voice-chat pin requests failed. This is a plan inspection and primary evaluation; it is not an Opus review of the final implementation.
