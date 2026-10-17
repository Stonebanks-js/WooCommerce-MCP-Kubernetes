/**
 * In-memory note store for the notes server. One instance lives for the lifetime of the
 * process (a fresh McpServer is built per request, so state must live outside it). Notes are
 * lost when the pod restarts; that is intentional for this demo upstream.
 */
import { randomBytes } from 'node:crypto';

export interface Note {
  id: string;
  title: string;
  body: string;
  tags: string[];
  created_at: string;
}

export interface NoteSummary {
  id: string;
  title: string;
  tags: string[];
  created_at: string;
  excerpt: string;
}

export interface NoteInput {
  title: string;
  body: string;
  tags?: string[] | undefined;
}

export interface NoteFilter {
  tag?: string | undefined;
  search?: string | undefined;
}

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const ID_LENGTH = 6;
const EXCERPT_LENGTH = 120;

export function generateNoteId(): string {
  const bytes = randomBytes(ID_LENGTH);
  let out = 'n_';
  for (let i = 0; i < ID_LENGTH; i += 1) {
    out += ID_ALPHABET[(bytes[i] as number) % ID_ALPHABET.length];
  }
  return out;
}

/** Trim, drop empties, de-duplicate case-insensitively while keeping the first spelling. */
export function normaliseTags(tags: string[] | undefined): string[] {
  if (!tags) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const tag = raw.trim();
    if (tag.length === 0) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}

export function makeExcerpt(body: string): string {
  const collapsed = body.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= EXCERPT_LENGTH) return collapsed;
  return `${collapsed.slice(0, EXCERPT_LENGTH).trimEnd()}...`;
}

export class NotesStore {
  private readonly notes = new Map<string, Note>();

  get size(): number {
    return this.notes.size;
  }

  create(input: NoteInput): Note {
    let id = generateNoteId();
    while (this.notes.has(id)) id = generateNoteId();
    const note: Note = {
      id,
      title: input.title,
      body: input.body,
      tags: normaliseTags(input.tags),
      created_at: new Date().toISOString(),
    };
    this.notes.set(id, note);
    return note;
  }

  get(id: string): Note | undefined {
    return this.notes.get(id);
  }

  delete(id: string): boolean {
    return this.notes.delete(id);
  }

  /**
   * Newest first. `tag` matches case-insensitively; `search` is a case-insensitive substring
   * match over title + body.
   */
  list(filter: NoteFilter = {}): { notes: NoteSummary[]; total: number } {
    const tag = filter.tag?.trim().toLowerCase();
    const search = filter.search?.trim().toLowerCase();
    const matches: NoteSummary[] = [];
    for (const note of [...this.notes.values()].reverse()) {
      if (tag && !note.tags.some((t) => t.toLowerCase() === tag)) continue;
      if (
        search &&
        !(note.title.toLowerCase().includes(search) || note.body.toLowerCase().includes(search))
      ) {
        continue;
      }
      matches.push({
        id: note.id,
        title: note.title,
        tags: note.tags,
        created_at: note.created_at,
        excerpt: makeExcerpt(note.body),
      });
    }
    return { notes: matches, total: matches.length };
  }

  clear(): void {
    this.notes.clear();
  }
}
