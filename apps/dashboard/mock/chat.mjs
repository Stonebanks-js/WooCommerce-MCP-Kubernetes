// Simulated chat agent: streams text, one tool_call/tool_result pair, more text, then done.
import { newId } from './data.mjs';
import { audit } from './audit.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export async function streamChat(req, res, user, messages, visibleTools) {
  const last = [...messages].reverse().find((m) => m.role === 'user');
  const prompt = (last?.content ?? '').trim();
  res.writeHead(200, {
    'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
  });
  let closed = false;
  req.on('close', () => { closed = true; });

  sse(res, 'start', { model: 'mock-model-1', provider: 'mock', toolCount: visibleTools.length });

  const tool = visibleTools.find((t) => t.name === 'list_orders') ?? visibleTools[0];
  const intro = tool
    ? `Sure — I'll look that up with ${tool.publicName}. `
    : 'I have no tools available to me right now, but here is what I know. ';
  for (const word of intro.split(' ')) {
    if (closed) return;
    sse(res, 'text', { delta: `${word} ` });
    await sleep(45);
  }

  const toolCalls = [];
  if (tool) {
    const id = `call_${newId().slice(0, 8)}`;
    const args = tool.name === 'list_orders' ? { status: 'processing', per_page: 3 } : {};
    sse(res, 'tool_call', { id, publicName: tool.publicName, serverSlug: tool.serverSlug, toolName: tool.name, args });
    await sleep(700);
    const outcome = tool.serverSlug === 'notes' ? 'unreachable' : 'success';
    const preview = outcome === 'success'
      ? JSON.stringify({ orders: [{ id: 1042, number: '1042', status: 'processing', total: '48.00', customer_name: 'Jane Doe' }, { id: 1041, number: '1041', status: 'processing', total: '12.00', customer_name: 'Sam Lee' }], total: 2, page: 1 }).slice(0, 500)
      : 'Upstream "notes" is unreachable: connect ECONNREFUSED';
    const durationMs = 180 + Math.floor(Math.random() * 400);
    sse(res, 'tool_result', { id, publicName: tool.publicName, outcome, durationMs, preview });
    toolCalls.push({ id, publicName: tool.publicName, serverSlug: tool.serverSlug, toolName: tool.name, args, outcome, durationMs, preview });
    audit.unshift({
      id: (audit[0]?.id ?? 1000) + 1, ts: new Date().toISOString(), userId: user.id, userEmail: user.email,
      source: 'chat', serverId: undefined, serverSlug: tool.serverSlug, toolName: tool.name, publicToolName: tool.publicName,
      durationMs, outcome, errorMessage: outcome === 'success' ? undefined : preview, argsPreview: JSON.stringify(args),
      resultBytes: outcome === 'success' ? preview.length : undefined,
    });
  }

  const answer = tool
    ? `\n\nThere are 2 orders in "processing": #1042 for Jane Doe ($48.00) and #1041 for Sam Lee ($12.00). You asked: "${prompt.slice(0, 80)}".`
    : `You asked: "${prompt.slice(0, 80)}". Ask an admin to enable a server so I can call tools.`;
  for (const word of answer.split(' ')) {
    if (closed) return;
    sse(res, 'text', { delta: `${word} ` });
    await sleep(35);
  }
  const message = `${intro}${answer}`.replace(/\s+$/, '');
  sse(res, 'done', { message, toolCalls });
  res.end();
}
