import { ErrorNote } from '../../ui/Field.js';
import { ToolCallCard } from './ToolCallCard.js';
import type { Turn } from './useChat.js';

export function TurnView({ turn }: { turn: Turn }) {
  if (turn.role === 'user') {
    return (
      <div className="turn turn-user">
        <div className="turn-label">You</div>
        <div className="turn-body">{turn.content}</div>
      </div>
    );
  }
  const idle = !turn.streaming && turn.text === '' && turn.toolCalls.length === 0 && !turn.error;
  return (
    <div className="turn turn-assistant">
      <div className="turn-label">
        Agent
        {turn.start && (
          <span className="subtle"> · {turn.start.model} · {turn.start.toolCount} tool{turn.start.toolCount === 1 ? '' : 's'}</span>
        )}
      </div>
      {turn.toolCalls.map((tc) => <ToolCallCard key={tc.call.id} view={tc} />)}
      {(turn.text !== '' || turn.streaming) && (
        <div className="turn-body">
          {turn.text}
          {turn.streaming && <span className="cursor" aria-hidden="true" />}
        </div>
      )}
      {idle && <div className="muted small">The agent returned no text.</div>}
      <ErrorNote message={turn.error} />
    </div>
  );
}
