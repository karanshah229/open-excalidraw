import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
function mcpServerControlPlugin() {
    let mcpProcess = null;
    const cleanup = () => {
        if (mcpProcess && mcpProcess.pid) {
            try {
                if (process.platform !== 'win32') {
                    process.kill(-mcpProcess.pid, 'SIGTERM');
                }
                else {
                    mcpProcess.kill();
                }
            }
            catch {
                try {
                    mcpProcess.kill();
                }
                catch {
                    /* ignore */
                }
            }
            mcpProcess = null;
        }
    };
    process.on('exit', cleanup);
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
    return {
        name: 'mcp-server-control',
        configureServer(server) {
            server.middlewares.use((req, res, next) => {
                if (req.url === '/api/mcp/start' && req.method === 'POST') {
                    if (mcpProcess && !mcpProcess.killed) {
                        res.statusCode = 200;
                        res.setHeader('Content-Type', 'application/json');
                        res.end(JSON.stringify({ ok: true, message: 'Already running', pid: mcpProcess.pid }));
                        return;
                    }
                    try {
                        const __dirname = path.dirname(fileURLToPath(import.meta.url));
                        const repoRoot = path.resolve(__dirname, '../..');
                        mcpProcess = spawn('pnpm', ['--filter', '@agentic-whiteboard/mcp', 'dev'], {
                            cwd: repoRoot,
                            env: { ...process.env },
                            detached: process.platform !== 'win32',
                            stdio: 'inherit',
                        });
                        mcpProcess.on('exit', () => {
                            mcpProcess = null;
                        });
                        res.statusCode = 200;
                        res.setHeader('Content-Type', 'application/json');
                        res.end(JSON.stringify({ ok: true, message: 'Started', pid: mcpProcess.pid }));
                    }
                    catch (err) {
                        const error = err instanceof Error ? err.message : String(err);
                        res.statusCode = 500;
                        res.setHeader('Content-Type', 'application/json');
                        res.end(JSON.stringify({ ok: false, error }));
                    }
                    return;
                }
                if (req.url === '/api/mcp/stop' && req.method === 'POST') {
                    cleanup();
                    res.statusCode = 200;
                    res.setHeader('Content-Type', 'application/json');
                    res.end(JSON.stringify({ ok: true, message: 'Stopped' }));
                    return;
                }
                if (req.url === '/api/mcp/process' && req.method === 'GET') {
                    res.statusCode = 200;
                    res.setHeader('Content-Type', 'application/json');
                    res.end(JSON.stringify({
                        running: Boolean(mcpProcess && !mcpProcess.killed),
                        pid: mcpProcess?.pid,
                    }));
                    return;
                }
                next();
            });
        },
    };
}
export default defineConfig({
    plugins: [mcpServerControlPlugin()],
});
