// Feature-local wire types for announcements (agent C), additive to the frozen contract; mirrored in
// apps/web/src/features/admin-tools/announcements/types.ts.
import type { AnnouncementDto, SaveAnnouncementRequestDto } from '@tcg-live/core';

export interface AnnouncementViewDto extends AnnouncementDto {
  /** Explicit opt-in to ping @everyone (allowedMentions.parse ['everyone']). Default false: nothing but the listed roles pings. */
  mentionEveryone: boolean;
  /** Status 'failed' because the bot was offline more than the grace window past the scheduled time. */
  missed: boolean;
}
/**
 * POST /api/v1/admin-tools/announcements, PUT /announcements/:id. scheduledAtMs null sends now unless
 * `draft` is true; a time schedules it.
 */
export interface SaveAnnouncementExtDto extends SaveAnnouncementRequestDto { mentionEveryone?: boolean; draft?: boolean }
export interface AnnouncementListDto { announcements: AnnouncementViewDto[] }

/** A scheduled announcement missed while offline is still sent on start when less than this late. */
export const ANNOUNCEMENT_GRACE_MS = 3_600_000;
export const MISSED_PREFIX = 'Missed:';
export const ANNOUNCEMENT_LIST_LIMIT = 100;
/** How far ahead an announcement may be scheduled. */
export const ANNOUNCEMENT_SCHEDULE_MAX_MS = 365 * 86_400_000;
