import { spawn } from 'node:child_process';
import { createApplication } from '../server/index.mjs';

const port = Number(process.env.LOCALSPACE_PORT || 4318);
const url = `http://127.0.0.1:${port}`;
function openBrowser() {
  const executable = process.platform === 'win32' ? 'rundll32.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  const child = spawn(executable, args, { windowsHide: true, detached: true, stdio: 'ignore', shell: false });
  child.on('error', () => console.log(`Open ${url} in your browser.`));
  child.unref();
}
let running = false;
try {
  const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1500) });
  const health = await response.json();
  running = health.ok && health.name === 'LocalSpace';
} catch { /* Start a new local instance. */ }
if (running) openBrowser();
else {
  try {
    const { server } = await createApplication();
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
    console.log(`LocalSpace is running at ${url}\nKeep this window open. Press Ctrl+C to stop.`);
    const shutdown = () => { server.close(); server.closeAllConnections(); };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    openBrowser();
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
