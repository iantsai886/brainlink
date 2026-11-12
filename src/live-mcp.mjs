// Refresh the configured access boundary before each request on long-lived AI connections.
import { loadConfig, configPath } from './config.mjs';
import { createContext } from './core.mjs';

export function createLiveMcp({ env, initialConfig, initialContext, createServer, httpTokenFromConfig = false }) {
  let signature = JSON.stringify(initialConfig);
  let server = createServer(initialContext);
  const initialHttpToken = initialConfig.http?.token;
  const failure = (message, request) => request?.id === undefined ? null : ({ jsonrpc: '2.0', id: request.id, error: { code: -32603, message } });
  return {
    async handleBody(body) {
      try {
        const config = await loadConfig(configPath(env));
        // The HTTP listener's bearer token cannot change in place. Refuse the old listener
        // after a saved token change; reopening BrainLink binds it with the new token.
        if (httpTokenFromConfig && config.http?.token !== initialHttpToken) throw new Error('BrainLink HTTP access changed. Restart the connection.');
        const nextSignature = JSON.stringify(config);
        if (nextSignature !== signature) {
          const nextServer = createServer(createContext(config, { env }));
          signature = nextSignature;
          server = nextServer;
        }
        return await server.handleBody(body);
      } catch {
        const message = 'BrainLink settings are unavailable or changed. Reopen the connection after checking Setup.';
        return Array.isArray(body) ? body.map((request) => failure(message, request)).filter(Boolean) : failure(message, body);
      }
    },
  };
}
