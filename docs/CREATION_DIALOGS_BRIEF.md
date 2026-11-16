# Brief: creation dialogs (frontend refinement)

Branch: `feat/creation-dialogs` (already checked out). Web only: `apps/web/src`. **Do not touch** `apps/server`, `packages/core`, or anything outside `apps/web`.

## Goal

Creating or editing things in Admin tools happens in a **pop-up editor** instead of forms that open inline and push the page down. The editor shows the thing being made: on the left the form, on the right a live **Discord preview** where it applies. After saving, the dialog closes, a toast confirms, and the new or edited item is **scrolled into view and briefly highlighted** in its list, so the admin can see where it landed. The tab pages become just lists with a clear primary "New …" button in the header.

## 1. Shared component (build first)

Create `apps/web/src/features/admin-tools/shared/EditorDialog.tsx`, built on the existing `Dialog` in `apps/web/src/ui/Dialog.tsx`. Don't write a new modal: reuse its focus trap, scroll lock, Escape handling and `dismissible`.
- **Props:** `open`, `title`, optional `description`, `children` (the form), optional `preview` (ReactNode), `footer` (action buttons), `busy` (blocks dismissal while saving), `dirty`, `onClose`.
- **Layout:**
  - With a preview, use `width="xl"` and a two-column grid (form | preview with a "Preview" heading). It stacks on narrow screens.
  - Without a preview, use `width="md"` or `"lg"`.
  - The body scrolls inside the dialog, and the footer stays visible.
- **Unsaved changes:** when `dirty` is set and the user presses Escape, clicks the backdrop or presses X, ask "Discard unsaved changes?" with the existing `ConfirmDialog` before closing. While `busy`, it can't be dismissed at all.
- **Highlight hook:** add `useHighlightNew()` (same folder) that returns `{ highlight(id), isHighlighted(id), ref(id) }`.
  - It scrolls the item's element into view (`block: 'nearest'`, respecting `prefers-reduced-motion`).
  - It applies a ~2 s highlight class, such as a ring or soft accent background, using existing CSS tokens in `ui/ui.css` (`--color-accent` etc.). No new colours.
- **Toasts:** use `useToast()` from `ui/Toast.tsx`. It's already provided at the app root; check before you assume.

## 2. Apply it to each creation flow

Keep all existing behaviour, validation, error text and API calls. This is a presentation change.

| Where | Today | Change to |
|---|---|---|
| `admin-tools/stickies/StickiesTab.tsx` | `StickyEditor` form inline above the list | "New sticky" and "Edit" open `EditorDialog`. Add a **preview** with `announcements/DiscordPreview.tsx` (content + embed from the draft). Highlight the saved sticky. **Do this one first: it's the reference implementation.** |
| `admin-tools/roles/RolesTab.tsx` (`PanelsSection` / `PanelEditor`) | Inline editor section | New and Edit panel open in `EditorDialog` with its existing preview. Keep the "a retry must update, not create a second one" logic (`draft.id` set after the first save) and the "Saved, but not posted" error, which must keep the dialog open. |
| `admin-tools/announcements/AnnouncementsTab.tsx` | Composer always shown at the top of the tab | The tab shows History with a "New announcement" header button. New and Edit open the composer in `EditorDialog` with its preview. The send/schedule `ConfirmDialog` stacks on top of the editor dialog, so check that focus and Escape behave. Deleting the announcement being edited still resets correctly. |
| `admin-tools/channels/ChannelsTab.tsx` | Permanent "Create a channel" section, then a separate reason `ConfirmDialog` | A "New channel" button in the tab header (only with `server.manage`) opens `EditorDialog` with name, Text/Voice, category **and the required reason** in one form. One step, with no second confirm for create. Lock, slowmode and purge keep their current confirms. After success, select the new channel in the channel picker (it already does this) and toast. |
| `admin-tools/bots/BotsTab.tsx` + `AddHelperWizard.tsx` | Wizard always shown under the bot list | An "Add helper bot" button (disabled when full or `disabled`, with a reason in a tooltip or hint) opens the wizard in `EditorDialog` (no preview). Keep its steps text. Highlight the new bot card after adding. |
| `features/setup/CreateChannelInline.tsx` | Expanding inline box under the picker | Keep the "New text channel / New voice room" ghost button, but open a small `EditorDialog` (`width="sm"`). **Keep** the `inFlight` ref guard, the `currentGuild` check and the auto-select via `onCreated`. Tests in `setup.test.tsx` depend on the group/label names; update the tests if roles change, but keep the same coverage, including the double-Enter test. |

Out of scope: member notes, the LFG editor, Settings sections, `RoomGrid`'s add-by-ID, and `AttachToCase` (already a dialog).

## 3. Rules

- **Style:** match the existing code: Tailwind classes and tokens from `ui/`, `lucide-react` icons, `Button`/`Field`/`Input` from `../../../ui`, comments only where intent isn't obvious, and each file's existing line endings (LF here).
- **Accessibility:** the dialog has a proper title, and focus goes to the first field. After closing, focus returns to the button that opened it. The `Dialog` may already do this; check. Every button has an accessible name.
- **Tests (Vitest + Testing Library, next to each tab):** update the existing tests for the new flow (open the dialog by button, then query `within(screen.getByRole('dialog'))`). Add tests for:
  - EditorDialog: the dirty-discard confirm, and no dismissal while busy.
  - Stickies: create through the dialog shows the preview and highlights the new item.
  - Channels: one-step create with the reason.
- **Must pass from the repo root:** `npm run typecheck:all` and `npm run test:all`. Don't skip or delete tests to get green.
- **Don't commit.** Leave changes in the working tree. The orchestrator reviews, runs the demo and commits.
- **Usage limits:** if you're stopped and resumed, run `git diff` first and continue from there.

## Report back

List the files changed, what each flow looks like now, any behaviour you had to change or couldn't keep, and the test counts.
