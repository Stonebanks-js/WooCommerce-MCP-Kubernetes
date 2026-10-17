export function Wordmark() {
  return (
    <div className="wordmark" aria-label="Urumi MCP Gateway">
      <span className="wordmark-mark" aria-hidden="true">
        <svg viewBox="0 0 32 32" width="22" height="22">
          <rect width="32" height="32" rx="7" fill="currentColor" />
          <path d="M9 9v9a7 7 0 0 0 14 0V9" fill="none" stroke="#fff" strokeWidth="3.2" strokeLinecap="round" />
        </svg>
      </span>
      <span className="wordmark-text">
        <span className="wordmark-name">Urumi</span>
        <span className="wordmark-sub">MCP Gateway</span>
      </span>
    </div>
  );
}
