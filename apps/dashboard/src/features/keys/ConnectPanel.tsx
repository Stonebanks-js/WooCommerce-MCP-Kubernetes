import { CopyButton } from '../../ui/CopyButton.js';

const PLACEHOLDER = '<your-key>';

function Snippet({ title, hint, text }: { title: string; hint: string; text: string }) {
  return (
    <div className="snippet">
      <div className="snippet-head">
        <h3>{title}</h3>
        <CopyButton text={text} />
      </div>
      <pre className="code-block">{text}</pre>
      <div className="snippet-hint">{hint}</div>
    </div>
  );
}

/** Copy-paste client setup. The real key is substituted only right after it was created. */
export function ConnectPanel({ mcpUrl, keyPlaintext }: { mcpUrl: string; keyPlaintext: string | null }) {
  const key = keyPlaintext ?? PLACEHOLDER;
  const claude = `claude mcp add --transport http urumi-gateway ${mcpUrl} --header "Authorization: Bearer ${key}"`;
  const cursor = JSON.stringify({
    mcpServers: {
      'urumi-gateway': { url: mcpUrl, headers: { Authorization: `Bearer ${key}` } },
    },
  }, null, 2);
  const inspector = `npx @modelcontextprotocol/inspector --cli --transport http --server-url ${mcpUrl} --header "Authorization: Bearer ${key}" --method tools/list`;

  return (
    <div className="card">
      <div className="card-title">Connect an MCP client</div>
      <p className="muted small">
        The gateway speaks Streamable HTTP at <span className="mono">{mcpUrl}</span>. Authenticate with
        <span className="mono"> Authorization: Bearer</span> (or <span className="mono">X-Api-Key</span>).
        {keyPlaintext
          ? ' Your new key is filled in below; it will not be shown again after you leave this page.'
          : ` Replace ${PLACEHOLDER} with a key from the list above.`}
      </p>
      <div className="connect-panel">
        <Snippet title="Claude Code" text={claude} hint="Run once in a terminal; Claude Code stores the server in its user config." />
        <Snippet title="Cursor (.cursor/mcp.json)" text={cursor} hint="Save as .cursor/mcp.json in a project, or ~/.cursor/mcp.json for all projects." />
        <Snippet title="MCP Inspector" text={inspector} hint="Or open the Inspector UI (npx @modelcontextprotocol/inspector), choose Streamable HTTP, paste the URL and add the Authorization header." />
      </div>
    </div>
  );
}
