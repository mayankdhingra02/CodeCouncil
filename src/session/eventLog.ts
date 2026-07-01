import { appendFile } from "node:fs/promises";

import {
  eventLogEntrySchema,
  type EventLogEntry,
  type TaskSession
} from "./schema.js";

export type EventLogEntryInput = Omit<EventLogEntry, "timestamp" | "metadata"> & {
  timestamp?: string;
  metadata?: Record<string, unknown>;
};

export function createEventLogEntry(
  input: EventLogEntryInput,
  now = new Date()
): EventLogEntry {
  return eventLogEntrySchema.parse({
    ...input,
    timestamp: input.timestamp ?? now.toISOString(),
    metadata: input.metadata ?? {}
  });
}

export async function appendEventLogEntry(
  eventsFile: string,
  input: EventLogEntryInput,
  now = new Date()
): Promise<EventLogEntry> {
  const event = createEventLogEntry(input, now);
  await appendFile(eventsFile, `${JSON.stringify(event)}\n`, "utf8");
  return event;
}

export async function appendSessionEvent(
  session: TaskSession,
  input: EventLogEntryInput,
  now = new Date()
): Promise<EventLogEntry> {
  return appendEventLogEntry(session.paths.eventsFile, input, now);
}

