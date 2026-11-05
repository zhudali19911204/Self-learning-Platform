// Compatibility entry point. Application logic lives in src/server.mjs.
import { pathToFileURL } from 'node:url';
import { createApp } from './src/server.mjs';
export * from './src/server.mjs';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 3000);
  createApp().listen(port, '127.0.0.1', () => console.log(`知行 Learnflow: http://localhost:${port}`));
}
