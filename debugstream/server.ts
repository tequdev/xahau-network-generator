import { open, stat, truncate } from 'node:fs/promises';
import { createServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';

const LOG_FILE = process.env.LOG_FILE ?? '/log/debug.log';
const PORT = Number(process.env.PORT ?? 8080);
// The file is only the hand-off from xahaud to this process; nothing reads
// history, so it only needs to hold what arrives between two polls.
const MAX_LOG_BYTES = 10 * 1024 * 1024;
// A client that stops reading would otherwise grow this process's heap.
const MAX_BUFFERED = 1024 * 1024;
const POLL_MS = 250;

// Hook trace()/trace_num() and friends are logged as e.g.
// `... View:TRC HookTrace[rHOOKACC-rOTXNACC]: message`. Nothing else in the
// debug log is ever sent to clients.
const HOOK_LINE = /Hook(?:Trace|Info|Error|Emit)\[/;
const ADDR = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;

// account is undefined for the unfiltered `/debugstream` firehose.
type Client = WebSocket & { account?: string; alive?: boolean };

const wss = new WebSocketServer({ noServer: true });

function broadcast(line: string) {
  if (!HOOK_LINE.test(line)) return;
  for (const c of wss.clients as Set<Client>) {
    if (c.readyState !== WebSocket.OPEN) continue;
    if (c.bufferedAmount > MAX_BUFFERED) {
      c.terminate();
      continue;
    }
    if (c.account === undefined || line.includes(c.account)) c.send(line);
  }
}

// --- Tailer ---------------------------------------------------------------
// We poll fs.stat instead of fs.watch: inotify events do not reliably cross
// Docker bind mounts (notably on macOS), whereas a stat always works.
let offset = 0;
let partial = ''; // trailing bytes of an unfinished line

try {
  offset = (await stat(LOG_FILE)).size; // start at the end: no history replay
} catch {}

// The file is opened per poll that finds new bytes, so a file replaced
// underneath us is simply read from its start next time.
async function poll() {
  try {
    const st = await stat(LOG_FILE);
    if (st.size < offset) {
      // Truncated (by us or by hand): start over and drop the half line.
      offset = 0;
      partial = '';
    }
    if (st.size > offset) {
      const buf = Buffer.alloc(st.size - offset);
      const fh = await open(LOG_FILE, 'r');
      let bytesRead = 0;
      try {
        ({ bytesRead } = await fh.read(buf, 0, buf.length, offset));
      } finally {
        await fh.close();
      }
      offset += bytesRead;
      // ponytail: a multibyte char split across reads would be mangled; hook
      // logs are ASCII in practice.
      const lines = (partial + buf.toString('utf8', 0, bytesRead)).split('\n');
      partial = lines.pop() ?? '';
      for (const l of lines) broadcast(l.replace(/\r$/, ''));
    }
    if (st.size > MAX_LOG_BYTES) {
      // xahaud opens the log with O_APPEND and never renames it, so truncating
      // from outside is safe (same principle as logrotate copytruncate). A
      // line xahaud writes between the read above and this truncate is lost;
      // that window is microseconds every few hours, accepted.
      // ponytail: truncate-to-zero cap; real rotation if someone needs history
      await truncate(LOG_FILE, 0);
      offset = 0;
      partial = '';
    }
  } catch (err) {
    // ENOENT is normal until xahaud writes its first line; keep polling.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(`[debugstream] tail error: ${(err as Error).message}`);
    }
    // A file deleted and recreated by hand must be read from its start.
    offset = 0;
    partial = '';
  }
  setTimeout(poll, POLL_MS);
}
poll();

// --- HTTP / WebSocket -----------------------------------------------------
// WebSocket only; plain HTTP has nothing to serve.
const server = createServer((_req, res) => {
  res.writeHead(404);
  res.end();
});

server.on('upgrade', (req, socket, head) => {
  const path = (req.url ?? '').split('?')[0];
  const m = /^\/debugstream(?:\/([^/]*))?$/.exec(path);
  const account = m?.[1] || undefined;
  if (!m || (account !== undefined && !ADDR.test(account))) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws: Client) => {
    ws.account = account;
    ws.alive = true;
    ws.on('pong', () => {
      ws.alive = true;
    });
    // Without an error listener a reset connection would crash the process.
    ws.on('error', () => {});
    console.log(`[debugstream] connect ${account ?? '*'}`);
    ws.on('close', () =>
      console.log(`[debugstream] disconnect ${account ?? '*'}`),
    );
  });
});

// Proxies and NATs silently drop idle connections; ping, and cull clients
// that never answered the previous ping.
setInterval(() => {
  for (const c of wss.clients as Set<Client>) {
    if (!c.alive) c.terminate();
    else {
      c.alive = false;
      c.ping();
    }
  }
}, 30_000);

server.listen(PORT, () => {
  console.log(`[debugstream] tailing ${LOG_FILE}, listening on :${PORT}`);
});

// PID 1 in a container ignores SIGTERM unless there is a handler for it.
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => process.exit(0));
}
