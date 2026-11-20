import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';

const JSON_TYPE = 'application/json; charset=utf-8';

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': randomUUID(),
    ...headers
  });
  res.end(text);
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// In-memory repositories store
interface Repo {
  owner: string;
  name: string;
  description: string;
  private: boolean;
  default_branch: string;
}

const repos = new Map<string, Repo>();

export function createApp(): Server {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const path = pathOf(req);
    const method = req.method ?? 'GET';
    const auth = req.headers['authorization'];

    // Protocol check: bad JSON in POST/PUT/PATCH should return 400
    let bodyBuffer: Buffer = Buffer.alloc(0);
    let jsonBody: any = null;
    if (['POST', 'PUT', 'PATCH'].includes(method)) {
      bodyBuffer = await readBody(req);
      if (req.headers['content-type']?.includes('application/json') && bodyBuffer.length > 0) {
        try {
          jsonBody = JSON.parse(bodyBuffer.toString('utf8'));
        } catch {
          sendJson(res, 400, { message: 'Problems parsing JSON' });
          return;
        }
      }
    }

    // Health probe
    if (method === 'GET' && path === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    // API Root
    if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
      sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
      return;
    }

    // API Meta
    if (method === 'GET' && path === '/api/v3/meta') {
      sendJson(res, 200, { installed_version: '3.14.0' });
      return;
    }

    // User repos
    if (path === '/api/v3/user/repos') {
      if (!auth) {
        sendJson(res, 401, { message: 'Requires authentication' });
        return;
      }
      if (method === 'POST') {
        const name = jsonBody?.name ?? 'repo';
        const repo: Repo = {
          owner: 'adaiversen',
          name,
          description: jsonBody?.description ?? '',
          private: jsonBody?.private ?? false,
          default_branch: 'main'
        };
        repos.set(`adaiversen/${name}`, repo);
        sendJson(res, 201, repo);
        return;
      }
      if (method === 'GET') {
        const list = Array.from(repos.values());
        sendJson(res, 200, list);
        return;
      }
    }

    // Default 404
    sendJson(res, 404, { message: 'Not Found' });
  });
}
