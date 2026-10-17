import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api.js';
import { errorMessage, isAbortError } from '../../lib/errors.js';
import type { ChatMessage, ChatStartData, ChatToolCallData, ChatToolResultData } from '../../types.js';

export interface ToolCallView { call: ChatToolCallData; result?: ChatToolResultData }
export interface UserTurn { id: number; role: 'user'; content: string }
export interface AssistantTurn {
  id: number; role: 'assistant'; text: string; toolCalls: ToolCallView[]; streaming: boolean;
  error?: string; start?: ChatStartData;
}
export type Turn = UserTurn | AssistantTurn;

type Patch = (turn: AssistantTurn) => AssistantTurn;

function toHistory(turns: Turn[]): ChatMessage[] {
  const history: ChatMessage[] = [];
  for (const t of turns) {
    if (t.role === 'user') history.push({ role: 'user', content: t.content });
    else if (t.text !== '') history.push({ role: 'assistant', content: t.text });
  }
  return history;
}

/** Owns the conversation state and drives one POST /api/chat SSE stream at a time. */
export function useChat() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [streaming, setStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const seq = useRef(0);

  useEffect(() => () => abortRef.current?.abort(), []);

  const patchAssistant = useCallback((id: number, patch: Patch) => {
    setTurns((list) => list.map((t) => (t.id === id && t.role === 'assistant' ? patch(t) : t)));
  }, []);

  const send = useCallback(async (content: string) => {
    const text = content.trim();
    if (text === '' || abortRef.current) return;
    const history = toHistory(turns);
    const userTurn: UserTurn = { id: ++seq.current, role: 'user', content: text };
    const assistantId = ++seq.current;
    setTurns((list) => [...list, userTurn, { id: assistantId, role: 'assistant', text: '', toolCalls: [], streaming: true }]);
    const controller = new AbortController();
    abortRef.current = controller;
    setStreaming(true);
    const update = (patch: Patch) => patchAssistant(assistantId, patch);
    try {
      for await (const ev of api.chat.stream([...history, { role: 'user', content: text }], controller.signal)) {
        switch (ev.type) {
          case 'start':
            update((t) => ({ ...t, start: ev.data }));
            break;
          case 'text':
            update((t) => ({ ...t, text: t.text + ev.data.delta }));
            break;
          case 'tool_call':
            update((t) => ({ ...t, toolCalls: [...t.toolCalls, { call: ev.data }] }));
            break;
          case 'tool_result':
            update((t) => {
              const known = t.toolCalls.some((tc) => tc.call.id === ev.data.id);
              const toolCalls = known
                ? t.toolCalls.map((tc) => (tc.call.id === ev.data.id ? { ...tc, result: ev.data } : tc))
                : [...t.toolCalls, { call: { id: ev.data.id, publicName: ev.data.publicName, serverSlug: '', toolName: '', args: undefined }, result: ev.data }];
              return { ...t, toolCalls };
            });
            break;
          case 'done':
            update((t) => ({ ...t, text: ev.data.message || t.text, streaming: false }));
            break;
          case 'error':
            update((t) => ({ ...t, error: ev.data.message, streaming: false }));
            break;
        }
      }
    } catch (err) {
      if (isAbortError(err)) update((t) => ({ ...t, error: t.text === '' ? 'Stopped.' : undefined }));
      else update((t) => ({ ...t, error: errorMessage(err) }));
    } finally {
      update((t) => ({ ...t, streaming: false }));
      abortRef.current = null;
      setStreaming(false);
    }
  }, [turns, patchAssistant]);

  const stop = useCallback(() => abortRef.current?.abort(), []);
  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setTurns([]);
    setStreaming(false);
  }, []);

  return { turns, streaming, send, stop, reset };
}
