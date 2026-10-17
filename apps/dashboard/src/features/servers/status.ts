import type { Server } from '../../types.js';

/** One-line description of a probe result, for toasts and the save confirmation. */
export function describeStatus(server: Server): string {
  switch (server.status) {
    case 'connected':
      return `connected, ${server.tools.length} tool${server.tools.length === 1 ? '' : 's'}`;
    case 'unreachable':
      return server.statusError ? `unreachable: ${server.statusError}` : 'unreachable';
    case 'disabled':
      return 'disabled';
  }
}

export const SLUG_PATTERN = /^[a-z][a-z0-9-]{1,19}$/;
