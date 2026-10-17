import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { api } from '../../api.js';
import { useAsync } from '../../lib/useAsync.js';
import { useConfig } from '../../lib/useConfig.js';
import { Button } from '../../ui/Button.js';
import { EmptyState } from '../../ui/EmptyState.js';
import { ErrorNote } from '../../ui/Field.js';
import { useAuth } from '../auth/AuthContext.js';
import { PageHeader } from '../layout/PageHeader.js';
import { TurnView } from './TurnView.js';
import { useChat } from './useChat.js';
import './chat.css';

export function ChatPage() {
  const { user } = useAuth();
  const config = useConfig();
  const tools = useAsync(() => api.tools.list(), 'tools');
  const { turns, streaming, send, stop, reset } = useChat();
  const [draft, setDraft] = useState('');
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const chat = config.data?.chat;
  const chatEnabled = chat?.enabled ?? false;
  const toolCount = tools.data?.tools.length;

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns]);

  const submit = () => {
    if (!chatEnabled || streaming || draft.trim() === '') return;
    void send(draft);
    setDraft('');
    inputRef.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const subtitle = (
    <span className="chat-meta">
      <span>Acting as <b>{user?.email}</b> ({user?.role})</span>
      <span aria-hidden="true">·</span>
      <span>{toolCount === undefined ? '… tools' : `${toolCount} tool${toolCount === 1 ? '' : 's'} visible`}</span>
      {chat && (
        <>
          <span aria-hidden="true">·</span>
          <span>{chat.enabled ? <>{chat.model} <span className="subtle">({chat.provider})</span></> : 'no LLM provider'}</span>
        </>
      )}
    </span>
  );

  return (
    <div className="chat-page">
      <PageHeader
        title="Chat"
        subtitle={subtitle}
        actions={(
          <>
            {streaming && <Button onClick={stop}>Stop</Button>}
            <Button onClick={reset} disabled={turns.length === 0}>New chat</Button>
          </>
        )}
      />
      {config.data && !chatEnabled && (
        <div className="notice">
          No LLM provider is configured, so the chat agent is unavailable. Set <code>LLM_PROVIDER</code> (and its API key)
          on the gateway to enable it. The MCP endpoint and tool catalogue work regardless.
        </div>
      )}
      <ErrorNote message={config.error ?? tools.error} />
      <div className="chat-log" ref={logRef}>
        {turns.length === 0 ? (
          <div className="chat-empty">
            <EmptyState
              title="Ask the agent to use your tools"
              hint={chatEnabled
                ? 'Try "list the last 5 orders" or "what time is it in Tokyo?" — tool calls appear inline.'
                : 'Chat is disabled until the gateway has an LLM provider.'}
            />
          </div>
        ) : turns.map((turn) => <TurnView key={turn.id} turn={turn} />)}
      </div>
      <div className="chat-composer">
        <textarea
          ref={inputRef}
          rows={2}
          value={draft}
          placeholder={chatEnabled ? 'Message the agent… (Enter to send, Shift+Enter for a new line)' : 'Chat is unavailable'}
          disabled={!chatEnabled}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          aria-label="Message"
        />
        <Button variant="primary" onClick={submit} disabled={!chatEnabled || streaming || draft.trim() === ''}>Send</Button>
      </div>
    </div>
  );
}
