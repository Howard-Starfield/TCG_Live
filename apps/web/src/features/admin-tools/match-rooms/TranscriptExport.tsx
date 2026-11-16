// Room chat transcripts as CSV / JSON, with the other event exports: one row per saved message.
import type { MatchRoomTranscriptDto } from '@tcg-live/core';
import { useAdminData } from '../../../data';
import { useAdminToolsAccess } from '../api';
import { EXPORT_ROW_CAP, ExportButtons, type ExportResult, type ExportRow } from '../shared/exportData';
import { getTranscript, getTranscripts } from './api';

/** A transcript with no saved messages still gets one row, so the file shows the room was archived. */
export function transcriptRows(transcript: MatchRoomTranscriptDto): ExportRow[] {
  const base = { eventId: transcript.eventId, matchId: transcript.matchId, room: transcript.channelName, channelId: transcript.channelId,
    archivedAt: new Date(transcript.archivedAtMs).toISOString(), reason: transcript.reason, contentAvailable: transcript.contentAvailable };
  if (transcript.messages.length === 0) return [base];
  return transcript.messages.map(message => ({ ...base, messageId: message.id, at: new Date(message.createdAtMs).toISOString(),
    authorId: message.authorId, author: message.authorName, content: message.content, attachments: message.attachments.map(item => item.url) }));
}

/** "Room chat transcripts" CSV and JSON for one event. */
export function TranscriptExportButtons({ eventId }: { eventId: string }) {
  const { api } = useAdminData();
  const access = useAdminToolsAccess();
  if (!access) return null;
  const collect = async (): Promise<ExportResult> => {
    const rows: ExportRow[] = [];
    for (const summary of await getTranscripts(api, eventId)) {
      rows.push(...transcriptRows(await getTranscript(api, summary.id)));
      if (rows.length >= EXPORT_ROW_CAP) return { rows: rows.slice(0, EXPORT_ROW_CAP), truncated: true };
    }
    return { rows, truncated: false };
  };
  return <ExportButtons name={`room-chat-${eventId.slice(0, 8)}`} label="room chat transcripts" collect={collect} />;
}
