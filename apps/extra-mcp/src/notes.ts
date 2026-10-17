/** Entrypoint for the notes server: `npm run start:notes` / `npm run dev:notes`. */
import { startServer } from './server.ts';
import { notesServer } from './servers/notes.ts';

startServer(notesServer);
