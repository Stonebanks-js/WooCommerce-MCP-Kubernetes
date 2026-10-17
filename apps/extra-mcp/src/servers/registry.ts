import type { ServerDefinition, ServerName } from '../server.ts';
import { notesServer } from './notes.ts';
import { utilsServer } from './utils.ts';

export const definitions: Readonly<Record<ServerName, ServerDefinition>> = Object.freeze({
  notes: notesServer,
  utils: utilsServer,
});

export const SERVER_NAMES: readonly ServerName[] = Object.freeze(['notes', 'utils']);

/** Resolve the `SERVER` env value; throws a descriptive error for anything else. */
export function selectDefinition(name: string | undefined): ServerDefinition {
  const key = name?.trim().toLowerCase();
  if (key === 'notes' || key === 'utils') return definitions[key];
  const got = name === undefined ? 'nothing' : JSON.stringify(name);
  throw new Error(`SERVER must be one of ${SERVER_NAMES.join(', ')} (got ${got})`);
}
