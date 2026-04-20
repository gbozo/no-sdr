// ============================================================
// node-sdr — Main Server Entry Point
// ============================================================
// Hono HTTP server + WebSocket for SDR streaming.
// Serves the built SolidJS frontend and provides REST API + WS.
// ============================================================

import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import { serveStatic } from '@hono/node-server/serve-static';
import { cors } from 'hono/cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig, writeDefaultConfig } from './config.js';
import { DongleManager } from './dongle-manager.js';
import { DecoderManager } from './decoder-manager.js';
import { WebSocketManager } from './ws-manager.js';
import { logger } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- Load Configuration ----
const configPath = process.env.NODE_SDR_CONFIG;
const config = loadConfig(configPath);

// ---- Initialize Core Systems ----
const dongleManager = new DongleManager(config);
const decoderManager = new DecoderManager();
const wsManager = new WebSocketManager(dongleManager, decoderManager, config.server.adminPassword);

// ---- Create Hono App ----
const app = new Hono();
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

// ---- Middleware ----
app.use('*', cors());

// ---- REST API Routes ----

// Server status
app.get('/api/status', (c) => {
  const status = wsManager.getStatus();
  return c.json({
    version: '0.1.0',
    uptime: process.uptime(),
    ...status,
  });
});

// List dongles
app.get('/api/dongles', (c) => {
  return c.json(dongleManager.getDongles());
});

// Get dongle info
app.get('/api/dongles/:id', (c) => {
  const dongle = dongleManager.getDongle(c.req.param('id'));
  if (!dongle) return c.json({ error: 'Not found' }, 404);
  return c.json(dongle);
});

// List profiles for a dongle
app.get('/api/dongles/:id/profiles', (c) => {
  const profiles = dongleManager.getProfiles(c.req.param('id'));
  return c.json(profiles);
});

// Generate default config (admin utility)
app.post('/api/admin/generate-config', (c) => {
  try {
    writeDefaultConfig();
    return c.json({ ok: true, message: 'Default config written to config/config.yaml' });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// ---- Admin REST API (password auth via Authorization header) ----

// Simple admin auth middleware
const adminAuth = async (c: any, next: any) => {
  const auth = c.req.header('Authorization');
  if (!auth) {
    return c.json({ error: 'Authorization required' }, 401);
  }

  // Support "Bearer <password>" or just the raw password
  const password = auth.startsWith('Bearer ') ? auth.slice(7) : auth;
  if (password !== config.server.adminPassword) {
    return c.json({ error: 'Invalid credentials' }, 403);
  }

  await next();
};

// Admin login check
app.post('/api/admin/login', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (body.password === config.server.adminPassword) {
    return c.json({ ok: true, message: 'Authenticated' });
  }
  return c.json({ error: 'Invalid password' }, 403);
});

// Admin: Start a dongle
app.post('/api/admin/dongles/:id/start', adminAuth, async (c) => {
  const dongleId = c.req.param('id');
  try {
    await dongleManager.startDongle(dongleId);
    return c.json({ ok: true, dongleId });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

// Admin: Stop a dongle
app.post('/api/admin/dongles/:id/stop', adminAuth, async (c) => {
  const dongleId = c.req.param('id');
  try {
    await dongleManager.stopDongle(dongleId);
    return c.json({ ok: true, dongleId });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

// Admin: Switch dongle profile
app.post('/api/admin/dongles/:id/profile', adminAuth, async (c) => {
  const dongleId = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const profileId = body.profileId;

  if (!profileId) {
    return c.json({ error: 'profileId is required' }, 400);
  }

  try {
    await dongleManager.switchProfile(dongleId, profileId);
    return c.json({ ok: true, dongleId, profileId });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

// Admin: Get server status with full details
app.get('/api/admin/status', adminAuth, (c) => {
  const status = wsManager.getStatus();
  return c.json({
    version: '0.1.0',
    uptime: process.uptime(),
    demoMode: config.server.demoMode ?? !!process.env.NODE_SDR_DEMO,
    memoryUsage: process.memoryUsage(),
    ...status,
  });
});

// List running decoders
app.get('/api/decoders', (c) => {
  return c.json(decoderManager.getRunningDecoders());
});

// Check available decoder binaries
app.get('/api/decoders/check', async (c) => {
  const results = await decoderManager.checkAllBinaries();
  return c.json(results);
});

// ---- WebSocket Endpoint ----
app.get(
  '/ws',
  upgradeWebSocket(() => {
    let clientId: string;

    return {
      onOpen(_event, ws) {
        clientId = wsManager.handleConnection(ws);
      },

      onMessage(event, _ws) {
        if (typeof event.data === 'string') {
          wsManager.handleMessage(clientId, event.data);
        } else if (event.data instanceof ArrayBuffer) {
          wsManager.handleMessage(clientId, event.data);
        }
      },

      onClose() {
        if (clientId) {
          wsManager.handleDisconnection(clientId);
        }
      },

      onError(event) {
        logger.error({ clientId, error: String(event) }, 'WebSocket error');
      },
    };
  }),
);

// ---- Serve Static Frontend ----
// In production, serve the built client from ../client/dist
// In development, the Vite dev server handles this via proxy

const clientDistPath = path.resolve(__dirname, '../../client/dist');
app.use('/assets/*', serveStatic({ root: clientDistPath }));
app.get('*', serveStatic({ root: clientDistPath, path: 'index.html' }));

// ---- Start Server ----
const server = serve(
  {
    fetch: app.fetch,
    hostname: config.server.host,
    port: config.server.port,
  },
  (info) => {
    logger.info(
      { host: info.address, port: info.port },
      `node-sdr server started`,
    );
    logger.info(
      { dongles: config.dongles.length },
      `Configured dongles: ${config.dongles.map((d) => d.name).join(', ')}`,
    );
  },
);

// Inject WebSocket upgrade handler
injectWebSocket(server);

// ---- Auto-start Dongles ----
dongleManager.autoStartAll().catch((err) => {
  logger.error({ error: (err as Error).message }, 'Failed to auto-start dongles');
});

// ---- Graceful Shutdown ----
async function shutdown(signal: string) {
  logger.info({ signal }, 'Shutting down...');
  await decoderManager.stopAll();
  await dongleManager.stopAll();
  server.close();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

export { app };
