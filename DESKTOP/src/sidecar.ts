import * as http from 'http';

export interface SidecarConfig {
  hostname: string;
  port: number;
  password: string;
  rootPath: string;
}

export interface SidecarMessage {
  type: 'request' | 'response' | 'error';
  id: string;
  method: string;
  params: Record<string, unknown>;
  result?: unknown;
}

export class SidecarServer {
  private server: http.Server | null = null;
  private port: number = 0;
  private password: string = '';

  async listen(config: SidecarConfig): Promise<void> {
    this.password = config.password;
    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => {
        if (req.headers.authorization !== `Bearer ${this.password}`) {
          res.writeHead(401);
          res.end('Unauthorized');
          return;
        }
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
          try {
            const msg = JSON.parse(body) as SidecarMessage;
            this.handleMessage(msg).then(result => {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ...result }));
            }).catch(err => {
              res.writeHead(500);
              res.end(JSON.stringify({ error: err.message }));
            });
          } catch {
            res.writeHead(400);
            res.end('Bad Request');
          }
        });
      });
      this.server.listen(config.port, config.hostname, () => {
        const addr = this.server?.address();
        if (addr && typeof addr === 'object') {
          this.port = addr.port;
        }
        resolve();
      });
    });
  }

  private async handleMessage(msg: SidecarMessage): Promise<{ id: string; result?: unknown }> {
    switch (msg.method) {
      case 'ping':
        return { id: msg.id, result: 'pong' };
      case 'health':
        return { id: msg.id, result: { status: 'ok', uptime: process.uptime() } };
      default:
        return { id: msg.id, result: { error: `Unknown method: ${msg.method}` } };
    }
  }

  getPort(): number { return this.port; }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
        this.server = null;
      } else {
        resolve();
      }
    });
  }
}

if (require.main === module) {
  const hostname = process.env.SIDECAR_HOST || '127.0.0.1';
  const port = parseInt(process.env.SIDECAR_PORT || '0', 10);
  const password = process.env.SIDECAR_PASSWORD || 'newmark-sidecar';
  const rootPath = process.env.SIDECAR_ROOT || process.cwd();

  const server = new SidecarServer();
  server.listen({ hostname, port, password, rootPath }).then(() => {
    const msg: SidecarMessage = { type: 'response', id: 'init', method: 'ready', params: {}, result: { port: server.getPort() } };
    if (process.send) process.send(msg);
    else console.log(JSON.stringify(msg));
  }).catch(err => {
    console.error('Sidecar failed:', err);
    process.exit(1);
  });

  process.on('SIGTERM', async () => {
    await server.stop();
    process.exit(0);
  });
}
