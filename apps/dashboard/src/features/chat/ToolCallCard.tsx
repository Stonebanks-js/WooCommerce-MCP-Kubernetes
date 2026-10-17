import { formatDuration, formatJson } from '../../lib/format.js';
import { Badge, OutcomeBadge } from '../../ui/Badge.js';
import type { ToolCallView } from './useChat.js';

export function ToolCallCard({ view }: { view: ToolCallView }) {
  const { call, result } = view;
  return (
    <div className="tool-card">
      <div className="tool-card-head">
        <span className="mono tool-card-name">{call.publicName}</span>
        {call.serverSlug && <Badge tone="info" mono>{call.serverSlug}</Badge>}
        <span className="grow" />
        {result ? (
          <>
            <OutcomeBadge outcome={result.outcome} />
            <span className="muted small num">{formatDuration(result.durationMs)}</span>
          </>
        ) : (
          <span className="row muted small"><span className="spinner spinner-dark" aria-hidden="true" /> running</span>
        )}
      </div>
      <details className="tool-card-args">
        <summary>Arguments</summary>
        <pre className="code-block">{formatJson(call.args ?? {})}</pre>
      </details>
      {result && result.preview !== '' && (
        <pre className={`tool-card-preview${result.outcome === 'success' ? '' : ' is-error'}`}>{result.preview}</pre>
      )}
    </div>
  );
}
