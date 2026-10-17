/**
 * "notes" upstream MCP server: an in-memory team notes scratchpad behind bearer auth.
 * Tools: create_note, list_notes, get_note, delete_note, get_current_time (the deliberate
 * name collision with the utils server, so the gateway's `<slug>__<tool>` namespacing is visible).
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { NotesStore } from '../lib/notes-store.ts';
import type { Logger } from '../logger.ts';
import type { ServerDefinition } from '../server.ts';
import { defineTool, fail, ok } from '../tools.ts';
import { VERSION } from '../version.ts';

export const NOTES_INSTRUCTIONS =
  'Team notes: a small in-memory scratchpad. Notes have an id (n_xxxxxx), title, body and tags. ' +
  'Use list_notes to find notes by tag or text, get_note for the full body, delete_note to remove one. ' +
  'Notes do not survive a restart of this server.';

export function registerNotesTools(server: McpServer, store: NotesStore, log: Logger): void {
  defineTool(server, log, {
    name: 'create_note',
    title: 'Create note',
    description:
      'Create a note in the team notes store. Returns the stored note including its generated id ' +
      '(n_xxxxxx) and created_at timestamp. Tags are optional and used for filtering in list_notes.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    input: {
      title: z.string().min(1).max(200).describe('Short title (1-200 characters)'),
      body: z.string().max(20000).describe('Note body, plain text or markdown (0-20000 characters)'),
      tags: z
        .array(z.string().max(50))
        .max(20)
        .optional()
        .describe('Optional tags, e.g. ["meeting", "q4"]. Trimmed, blanks dropped, de-duplicated case-insensitively.'),
    },
    handler: ({ title, body, tags }) => ok({ ...store.create({ title, body, tags }) }),
  });

  defineTool(server, log, {
    name: 'list_notes',
    title: 'List notes',
    description:
      'List notes, newest first, optionally filtered by tag (case-insensitive) and/or a case-insensitive ' +
      'text search over title and body. Returns summaries with an excerpt; use get_note for the full body.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    input: {
      tag: z.string().min(1).max(50).optional().describe('Only notes carrying this tag'),
      search: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe('Substring to look for in title or body (case-insensitive)'),
    },
    handler: ({ tag, search }) => ok(store.list({ tag, search })),
  });

  defineTool(server, log, {
    name: 'get_note',
    title: 'Get note',
    description: 'Fetch one note (title, body, tags, created_at) by id. Fails if the id is unknown.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    input: {
      id: z.string().min(1).max(64).describe('Note id as returned by create_note or list_notes, e.g. n_ab12cd'),
    },
    handler: ({ id }) => {
      const note = store.get(id);
      return note ? ok({ ...note }) : fail(`Note not found: ${id}`);
    },
  });

  defineTool(server, log, {
    name: 'delete_note',
    title: 'Delete note',
    description: 'Permanently delete a note by id. Fails if the id is unknown.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    input: {
      id: z.string().min(1).max(64).describe('Note id to delete'),
    },
    handler: ({ id }) => (store.delete(id) ? ok({ deleted: true, id }) : fail(`Note not found: ${id}`)),
  });

  defineTool(server, log, {
    name: 'get_current_time',
    title: 'Get current time (notes)',
    description:
      'Current time in UTC as seen by the notes server, handy for timestamping notes. ' +
      'Returns {iso, unix, timezone: "UTC", server: "notes"}.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    input: {},
    handler: () => {
      const now = new Date();
      return ok({
        iso: now.toISOString(),
        unix: Math.floor(now.getTime() / 1000),
        timezone: 'UTC',
        server: 'notes',
      });
    },
  });
}

export const notesServer: ServerDefinition = {
  name: 'notes',
  version: VERSION,
  auth: { kind: 'bearer' },
  instructions: NOTES_INSTRUCTIONS,
  createRegistrar(log) {
    // One store per app: it must outlive the per-request McpServer instances.
    const store = new NotesStore();
    return (server) => registerNotesTools(server, store, log);
  },
};
