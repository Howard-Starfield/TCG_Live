import { HttpError } from '../admin/http/respond.js';
import { RuleError } from '../rehearsal/domain.js';
import { isDatabaseUnavailable } from '../tournaments/routes.js';

// These extend RuleError so withClient() rethrows them unwrapped. mapOpsError() checks them before the
// generic RuleError-means-unavailable rule.
/** Invalid client input; the message is safe to show. */
export class OpsInputError extends RuleError {}
/** The target row does not exist. */
export class OpsNotFoundError extends RuleError {}
/** The request conflicts with current state (for example a held item cannot be deleted). */
export class OpsConflictError extends RuleError {}

/** PostgreSQL foreign-key violation: the referenced event does not exist. */
export function isForeignKeyViolation(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  const cause = (error as { cause?: { code?: unknown } })?.cause?.code;
  return code === '23503' || cause === '23503';
}

/**
 * Maps store errors to safe HTTP errors for the evidence and moderation routes. Database outages and
 * missing schema become 503 with `unavailableMessage`; anything else propagates to be logged as a 500.
 */
export function mapOpsError(error: unknown, unavailableMessage: string): never {
  if (error instanceof HttpError) throw error;
  if (error instanceof OpsInputError) throw new HttpError(400, 'bad_request', error.message);
  if (error instanceof OpsNotFoundError) throw new HttpError(404, 'not_found', error.message);
  if (error instanceof OpsConflictError) throw new HttpError(409, 'conflict', error.message);
  if (isForeignKeyViolation(error)) throw new HttpError(404, 'not_found', 'That tournament does not exist.');
  if (isDatabaseUnavailable(error)) throw new HttpError(503, 'unavailable', unavailableMessage);
  throw error;
}
