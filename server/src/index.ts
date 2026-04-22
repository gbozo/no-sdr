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

import { loadConfig, writeDefaultConfig, saveConfig } from './config.js';
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

// ---- Admin: Dongle Management ----

// Get all dongles with full config (for admin UI)
app.get('/api/admin/dongles', adminAuth, (c) => {
  return c.json(dongleManager.getConfig().dongles);
});

// Get full config for a specific dongle
app.get('/api/admin/dongles/:id', adminAuth, (c) => {
  const dongleId = c.req.param('id');
  const dongle = dongleManager.getConfig().dongles.find(d => d.id === dongleId);
  if (!dongle) return c.json({ error: 'Dongle not found' }, 404);
  return c.json(dongle);
});

// Create a new dongle
app.post('/api/admin/dongles', adminAuth, async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || !body.id || !body.name) {
    return c.json({ error: 'Required fields: id, name' }, 400);
  }

  try {
    const config = dongleManager.getConfig();
    if (config.dongles.some(d => d.id === body.id)) {
      return c.json({ error: 'Dongle ID already exists' }, 400);
    }
    config.dongles.push({
      id: body.id,
      deviceIndex: body.deviceIndex ?? 0,
      name: body.name,
      serial: body.serial,
      ppmCorrection: body.ppmCorrection ?? 0,
      source: body.source ?? { type: 'local' },
      profiles: body.profiles ?? [],
      autoStart: body.autoStart ?? true,
      ...body,
    });
    saveConfig(config);
    return c.json({ ok: true, dongles: config.dongles }, 201);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

// Update an existing dongle
app.put('/api/admin/dongles/:id', adminAuth, async (c) => {
  const dongleId = c.req.param('id');
  const body = await c.req.json().catch(() => null);
  if (!body) {
    return c.json({ error: 'Request body required' }, 400);
  }

  try {
    const config = dongleManager.getConfig();
    const idx = config.dongles.findIndex(d => d.id === dongleId);
    if (idx === -1) return c.json({ error: 'Dongle not found' }, 404);
    config.dongles[idx] = { ...config.dongles[idx], ...body, id: dongleId };
    saveConfig(config);
    return c.json({ ok: true, dongle: config.dongles[idx] });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

// Delete a dongle
app.delete('/api/admin/dongles/:id', adminAuth, async (c) => {
  const dongleId = c.req.param('id');

  try {
    const config = dongleManager.getConfig();
    const idx = config.dongles.findIndex(d => d.id === dongleId);
    if (idx === -1) return c.json({ error: 'Dongle not found' }, 404);
    config.dongles.splice(idx, 1);
    saveConfig(config);
    return c.json({ ok: true, message: `Dongle ${dongleId} deleted` });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

// ---- Admin: Profile CRUD ----

// Create a new profile for a dongle
app.post('/api/admin/dongles/:id/profiles', adminAuth, async (c) => {
  const dongleId = c.req.param('id');
  const body = await c.req.json().catch(() => null);
  if (!body || !body.id || !body.name || !body.centerFrequency || !body.sampleRate) {
    return c.json({
      error: 'Required fields: id, name, centerFrequency, sampleRate',
    }, 400);
  }

  // Apply defaults for optional fields
  const profile = {
    id: body.id,
    dongleId,
    name: body.name,
    centerFrequency: body.centerFrequency,
    sampleRate: body.sampleRate,
    fftSize: body.fftSize ?? 2048,
    fftFps: body.fftFps ?? 30,
    defaultMode: body.defaultMode ?? 'nfm',
    defaultTuneOffset: body.defaultTuneOffset ?? 0,
    defaultBandwidth: body.defaultBandwidth ?? 12_500,
    gain: body.gain ?? null,
    description: body.description ?? '',
    decoders: body.decoders ?? [],
  };

  try {
    const profiles = dongleManager.addProfile(dongleId, profile);
    saveConfig(dongleManager.getConfig());
    return c.json({ ok: true, profiles }, 201);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

// Update an existing profile
app.put('/api/admin/dongles/:id/profiles/:profileId', adminAuth, async (c) => {
  const dongleId = c.req.param('id');
  const profileId = c.req.param('profileId');
  const body = await c.req.json().catch(() => null);
  if (!body) {
    return c.json({ error: 'Request body required' }, 400);
  }

  try {
    const updated = dongleManager.updateProfile(dongleId, profileId, body);
    saveConfig(dongleManager.getConfig());
    return c.json({ ok: true, profile: updated });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

// Delete a profile
app.delete('/api/admin/dongles/:id/profiles/:profileId', adminAuth, async (c) => {
  const dongleId = c.req.param('id');
  const profileId = c.req.param('profileId');

  try {
    dongleManager.deleteProfile(dongleId, profileId);
    saveConfig(dongleManager.getConfig());
    return c.json({ ok: true, message: `Profile ${profileId} deleted` });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

// Save current config to disk (admin utility)
app.post('/api/admin/save-config', adminAuth, (c) => {
  try {
    saveConfig(dongleManager.getConfig());
    return c.json({ ok: true, message: 'Configuration saved to disk' });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
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
  upgradeWebSocket((c) => {
    let clientId: string;
    // Extract client IP — check X-Forwarded-For for reverse-proxy deployments
    const ip = c.req.header('x-forwarded-for')?.split(',')[0].trim()
      ?? c.req.header('x-real-ip')
      ?? (c.req.raw as any)?.socket?.remoteAddress
      ?? 'unknown';

    return {
      onOpen(_event, ws) {
        clientId = wsManager.handleConnection(ws, ip);
      },

      onMessage(event, _ws) {
        if (!clientId) return; // connection was rate-limited
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
