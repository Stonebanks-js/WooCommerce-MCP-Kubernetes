/**
 * "utils" upstream MCP server: stateless helpers behind an `X-Api-Key` header credential.
 * Tools: get_current_time (collides with notes on purpose), calculate, convert_currency,
 * generate_uuid.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CalcError, MAX_EXPRESSION_LENGTH, evaluate } from '../lib/calculator.ts';
import {
  CurrencyError,
  RATES_AS_OF,
  SUPPORTED_CURRENCIES,
  convertCurrency,
  describeRates,
} from '../lib/currency.ts';
import type { Logger } from '../logger.ts';
import type { ServerDefinition } from '../server.ts';
import { defineTool, fail, ok } from '../tools.ts';
import { VERSION } from '../version.ts';

export const UTILS_INSTRUCTIONS =
  'Utilities: current time in any IANA timezone, a safe arithmetic calculator, currency conversion ' +
  'from a static rate table, and UUID generation. Nothing here talks to external services.';

export interface TimeInZone {
  timezone: string;
  local: string;
  utc_offset: string;
}

/** Format `now` in an IANA timezone; undefined when the timezone is not recognised. */
export function formatInTimezone(now: Date, timezone: string): TimeInZone | undefined {
  let formatter: Intl.DateTimeFormat;
  let offsetFormatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
      timeZoneName: 'short',
    });
    offsetFormatter = new Intl.DateTimeFormat('en-US', { timeZone: timezone, timeZoneName: 'longOffset' });
  } catch {
    return undefined;
  }
  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(now)) {
    if (part.type !== 'literal') parts[part.type] = part.value;
  }
  const rawOffset = offsetFormatter.formatToParts(now).find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
  const utcOffset = rawOffset === 'GMT' ? '+00:00' : rawOffset.replace('GMT', '');
  // ICU may canonicalise to a legacy alias (Node 26 resolves "Asia/Kolkata" as "Asia/Calcutta",
  // "Europe/Kyiv" as "Europe/Kiev"). Echo the caller's name, only borrowing ICU's casing when the
  // two differ by case alone ("utc" -> "UTC"), so the field is stable across Node/ICU versions.
  const resolved = formatter.resolvedOptions().timeZone;
  const requested = timezone.trim();
  return {
    timezone: resolved.toLowerCase() === requested.toLowerCase() ? resolved : requested,
    local: `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} ${parts.timeZoneName ?? ''}`.trim(),
    utc_offset: utcOffset,
  };
}

export function registerUtilsTools(server: McpServer, log: Logger): void {
  defineTool(server, log, {
    name: 'get_current_time',
    title: 'Get current time (utils)',
    description:
      'Current time, optionally in an IANA timezone such as "Europe/Berlin" or "Asia/Kolkata" (default UTC). ' +
      'Returns {iso, unix, timezone, local, utc_offset, server: "utils"}. Fails on an unknown timezone.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    input: {
      timezone: z
        .string()
        .min(1)
        .max(64)
        .optional()
        .describe('IANA timezone name, e.g. "America/New_York". Defaults to "UTC".'),
    },
    handler: ({ timezone }) => {
      const zone = timezone ?? 'UTC';
      const now = new Date();
      const formatted = formatInTimezone(now, zone);
      if (!formatted) {
        return fail(`Unknown timezone "${zone}". Use an IANA name such as "Europe/Berlin" or "Asia/Kolkata".`);
      }
      return ok({
        iso: now.toISOString(),
        unix: Math.floor(now.getTime() / 1000),
        timezone: formatted.timezone,
        local: formatted.local,
        utc_offset: formatted.utc_offset,
        server: 'utils',
      });
    },
  });

  defineTool(server, log, {
    name: 'calculate',
    title: 'Calculate',
    description:
      'Evaluate an arithmetic expression safely (no code execution). Supports + - * / % (remainder) ' +
      '^ (power, right-associative), parentheses, unary minus and decimal numbers like 3.5 or 1e3. ' +
      'Returns {expression, result}. Fails on bad syntax, division by zero or a non-finite result.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    input: {
      expression: z
        .string()
        .min(1)
        .max(MAX_EXPRESSION_LENGTH)
        .describe('Expression to evaluate, e.g. "(2 + 3) * 4 ^ 2 % 7"'),
    },
    handler: ({ expression }) => {
      try {
        return ok({ expression, result: evaluate(expression) });
      } catch (err) {
        if (err instanceof CalcError) return fail(`Cannot evaluate "${expression}": ${err.message}`);
        throw err;
      }
    },
  });

  defineTool(server, log, {
    name: 'convert_currency',
    title: 'Convert currency',
    description:
      `Convert an amount between ${SUPPORTED_CURRENCIES.join(', ')} using a STATIC demo rate table ` +
      `(${describeRates()}); rates are not live. Codes are case-insensitive. ` +
      `Returns {amount, from, to, rate, converted, rates_as_of: "${RATES_AS_OF}"}. Fails on an unknown code.`,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    input: {
      amount: z.number().nonnegative().describe('Amount in the source currency'),
      from: z.string().min(1).max(10).describe('Source currency code, e.g. "USD"'),
      to: z.string().min(1).max(10).describe('Target currency code, e.g. "INR"'),
    },
    handler: ({ amount, from, to }) => {
      try {
        return ok({ ...convertCurrency(amount, from, to) });
      } catch (err) {
        if (err instanceof CurrencyError) return fail(err.message);
        throw err;
      }
    },
  });

  defineTool(server, log, {
    name: 'generate_uuid',
    title: 'Generate UUID',
    description: 'Generate a random RFC 4122 version 4 UUID. Returns {uuid}.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    input: {},
    handler: () => ok({ uuid: randomUUID() }),
  });
}

export const utilsServer: ServerDefinition = {
  name: 'utils',
  version: VERSION,
  auth: { kind: 'header', name: 'X-Api-Key' },
  instructions: UTILS_INSTRUCTIONS,
  createRegistrar(log) {
    return (server) => registerUtilsTools(server, log);
  },
};
