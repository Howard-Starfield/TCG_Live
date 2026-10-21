// Admin actions (L10 web-commands): command client, useAdminCommand, action slots, reason dialogs and
// the command composer. The shell mounts CommandsProvider; console and list components render the slots.
export { CommandsProvider, useCommands } from './CommandsProvider';
export type { CommandsApi, CommandsProviderProps, MatchActionRequest, RemoveRequest } from './CommandsProvider';
export { useAdminCommand } from './useAdminCommand';
export type { AdminCommandApi, CommandOutcome, RunOptions } from './useAdminCommand';
export { createCommandClient, isRetryable, RETRY_DELAYS_MS } from './client';
export type { CommandClient, CommandClientOptions } from './client';
export { EventActions, MatchActions, RemoveMemberAction, useMatchActionsAvailable, useRemoveAvailable } from './actions';
export type { MatchActionsProps } from './actions';
export { ConsoleComposer } from './ConsoleComposer';
export type { ConsoleComposerProps } from './ConsoleComposer';
export { MatchActionDialog, RemoveMemberDialog } from './dialogs';
export { COMMAND_SPECS, parseCommand, suggest, usage, mentionFor, resolveMention } from './grammar';
export type { CommandSpec, ComposerIntent, ParseResult, Suggestion, SuggestionList } from './grammar';
export {
  availableEventActions, availableMatchActions, canRefreshPanels, canRemoveMember, canRun, canRunAny, checkReason,
  commandsEnabled, errorMessage, isWritable, preconditionFor
} from './model';
