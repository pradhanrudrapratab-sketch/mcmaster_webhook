const mineflayer = require('mineflayer');
const http = require('http');
const url = require('url');
const net = require('net');
const dns = require('dns').promises;
require('dotenv').config();

/*
 * DERTORRAP Minecraft Anti-AFK / Player-Aware Bot
 *
 * Main behaviour:
 *   /start
 *      -> check Minecraft server first
 *      -> offline: return "Server offline"
 *      -> online + < 3 players: try to join
 *      -> online + >= 3 players: monitor every 60s until < 3
 *
 *   Once bot is connected:
 *      -> check player count every 5 minutes
 *      -> if > 4 players: bot leaves and starts 60s monitoring
 *
 *   If a connection is rejected because the bot is banned:
 *      -> increment username (playez -> playfa)
 *      -> try the next username
 *
 *   /stop:
 *      -> stop bot, reconnect, 1-minute monitor and 5-minute checker
 *
 * Environment variables:
 *   PORT=3000
 *   API_KEY=optional
 *   MC_IP=optional
 *   MC_PORT=optional
 *   MC_USERNAME=BotPlayer
 *   MC_VERSION=optional
 *   MC_AUTH=offline
 */

const PORT = Number(process.env.PORT) || 3000;
const API_KEY = process.env.API_KEY || null;

const JOIN_PLAYER_LIMIT = 3;       // Join only when online players < 3
const LEAVE_PLAYER_LIMIT = 4;      // Leave when online players > 4
const WAIT_CHECK_MS = 60 * 1000;   // 1 minute
const BOT_CHECK_MS = 5 * 60 * 1000; // 5 minutes
const CONNECT_TIMEOUT_MS = 15000;

let state = {
  ip: process.env.MC_IP || null,
  port: Number.parseInt(process.env.MC_PORT, 10) || 25565,
  portSet: !!process.env.MC_PORT,

  botUsername: process.env.MC_USERNAME || 'BotPlayer',
  mcVersion: process.env.MC_VERSION || null,
  mcAuth: process.env.MC_AUTH || 'offline',

  bot: null,
  connected: false,

  autoReconnect: false,
  reconnectTimer: null,

  monitorTimer: null,
  monitorActive: false,
  botCheckTimer: null,

  jumpInterval: null,
  moveInterval: null,
  sneakActive: false,

  joinTime: null,
  disconnectReason: null,
  lastError: null,

  lastServerCheck: null,
  lastPlayerCount: null,
  lastServerOnline: null,

  logs: [],
};

// ─────────────────────────────────────────────────────────────────────────────
// Logger
// ─────────────────────────────────────────────────────────────────────────────

function log(message) {
  const entry = {
    time: new Date().toISOString(),
    msg: String(message),
  };

  console.log(`[${entry.time}] ${entry.msg}`);

  state.logs.push(entry);
  if (state.logs.length > 30) state.logs.shift();
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function formatUptime(seconds) {
  if (!seconds) return '0s';

  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;

  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function getUptimeSeconds() {
  if (!state.joinTime) return null;
  return Math.floor((Date.now() - state.joinTime.getTime()) / 1000);
}

function clearTimer(timerName) {
  if (state[timerName]) {
    clearTimeout(state[timerName]);
    clearInterval(state[timerName]);
    state[timerName] = null;
  }
}

function clearReconnectTimer() {
  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }
}

function clearAllActions() {
  if (state.jumpInterval) {
    clearInterval(state.jumpInterval);
    state.jumpInterval = null;
  }

  if (state.moveInterval) {
    clearInterval(state.moveInterval);
    state.moveInterval = null;
  }

  if (state.bot && state.sneakActive) {
    try {
      state.bot.setControlState('sneak', false);
    } catch (_) {}
  }

  state.sneakActive = false;
}

function stopPlayerMonitor() {
  if (state.monitorTimer) {
    clearTimeout(state.monitorTimer);
    clearInterval(state.monitorTimer);
    state.monitorTimer = null;
  }

  state.monitorActive = false;
  log('1-minute player monitor stopped');
}

function stopBotPlayerChecker() {
  if (state.botCheckTimer) {
    clearInterval(state.botCheckTimer);
    state.botCheckTimer = null;
  }

  log('5-minute bot player checker stopped');
}

function stopMonitoring() {
  stopPlayerMonitor();
  stopBotPlayerChecker();
}

function jsonHeaders(contentType = 'application/json') {
  return {
    'Content-Type': contentType,
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  };
}

function jsonOk(res, data = {}) {
  res.writeHead(200, jsonHeaders());
  res.end(JSON.stringify({ success: true, ...data }, null, 2));
}

function jsonError(res, code, message, extra = {}) {
  res.writeHead(code, jsonHeaders());
  res.end(JSON.stringify({
    success: false,
    error: message,
    ...extra,
  }, null, 2));
}

function normalizeText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch (_) {
    return String(value);
  }
}

function looksLikeBan(reason) {
  const text = normalizeText(reason).toLowerCase();

  // Keep this intentionally focused on ban-related server messages.
  const banPatterns = [
    /\bbanned\b/,
    /\bban(?:ned|ning)?\b/,
    /\bblacklist(?:ed)?\b/,
    /\bblacklisted\b/,
    /you are banned/,
    /you have been banned/,
    /permanently banned/,
    /temporarily banned/,
    /account.*banned/,
  ];

  return banPatterns.some((pattern) => pattern.test(text));
}

// ─────────────────────────────────────────────────────────────────────────────
// Username increment
// Example: playez -> playfa
// This increments the trailing alphabetic portion like a base-26 counter.
// ─────────────────────────────────────────────────────────────────────────────

function incrementUsername(username) {
  if (!username) return 'BotPlayer';

  const chars = username.split('');

  // Find the last alphabetic character.
  let i = chars.length - 1;
  while (i >= 0 && !/[a-zA-Z]/.test(chars[i])) i--;

  if (i < 0) {
    return `${username}a`;
  }

  // Carry through consecutive alphabetic characters.
  while (i >= 0 && /[a-zA-Z]/.test(chars[i])) {
    const lower = chars[i].toLowerCase();

    if (lower !== 'z') {
      const next = String.fromCharCode(lower.charCodeAt(0) + 1);
      chars[i] = chars[i] === chars[i].toUpperCase()
        ? next.toUpperCase()
        : next;
      return chars.join('');
    }

    chars[i] = chars[i] === chars[i].toUpperCase() ? 'A' : 'a';
    i--;
  }

  // Entire trailing alphabetic block overflowed:
  // zz -> aaa, AZ -> BA, etc.
  const prefix = chars.slice(0, i + 1).join('');
  const alphaStart = i + 1;
  const alphaLength = username.length - alphaStart;

  return prefix + 'a'.repeat(alphaLength + 1);
}

// ─────────────────────────────────────────────────────────────────────────────
// Minecraft Server Status
//
// Uses the Minecraft Server List Ping protocol directly.
// No second Minecraft bot connection is required just to count players.
// ─────────────────────────────────────────────────────────────────────────────

function writeVarInt(value) {
  const bytes = [];
  let num = value >>> 0;

  do {
    let temp = num & 0x7f;
    num >>>= 7;

    if (num !== 0) temp |= 0x80;
    bytes.push(temp);
  } while (num !== 0);

  return Buffer.from(bytes);
}

function writeString(value) {
  const data = Buffer.from(String(value), 'utf8');
  return Buffer.concat([writeVarInt(data.length), data]);
}

function readVarInt(buffer, offset = 0) {
  let numRead = 0;
  let result = 0;
  let byte;

  do {
    if (offset + numRead >= buffer.length) {
      throw new Error('Incomplete VarInt');
    }

    byte = buffer[offset + numRead];
    result |= (byte & 0x7f) << (7 * numRead);
    numRead++;

    if (numRead > 5) {
      throw new Error('VarInt too big');
    }
  } while ((byte & 0x80) !== 0);

  return {
    value: result,
    size: numRead,
  };
}

function buildStatusPacket(host, port) {
  // Handshake:
  // packet id 0x00
  // protocol version -1 (unknown)
  // server address
  // server port
  // next state 1 (status)
  const protocolVersion = writeVarInt(0xFFFFFFFF);
  const handshake = Buffer.concat([
    writeVarInt(0x00),
    protocolVersion,
    writeString(host),
    Buffer.from([(port >> 8) & 0xff, port & 0xff]),
    writeVarInt(1),
  ]);

  // Status request: packet id 0x00
  const request = Buffer.from([0x00]);

  const handshakePacket = Buffer.concat([
    writeVarInt(handshake.length),
    handshake,
  ]);

  const requestPacket = Buffer.concat([
    writeVarInt(request.length),
    request,
  ]);

  return Buffer.concat([handshakePacket, requestPacket]);
}

function pingMinecraftServer(host, port, timeout = CONNECT_TIMEOUT_MS) {
  return new Promise(async (resolve, reject) => {
    let address = host;

    try {
      const lookup = await dns.lookup(host);
      address = lookup.address;
    } catch (_) {
      // net.connect can still handle hostnames.
    }

    const socket = new net.Socket();
    let chunks = [];
    let settled = false;

    const finish = (error, result) => {
      if (settled) return;
      settled = true;

      try {
        socket.destroy();
      } catch (_) {}

      if (error) reject(error);
      else resolve(result);
    };

    const timer = setTimeout(() => {
      finish(new Error(`Server ping timeout after ${timeout}ms`));
    }, timeout);

    socket.setTimeout(timeout);

    socket.once('timeout', () => {
      clearTimeout(timer);
      finish(new Error(`Server ping timeout after ${timeout}ms`));
    });

    socket.once('error', (err) => {
      clearTimeout(timer);
      finish(err);
    });

    socket.once('connect', () => {
      try {
        socket.write(buildStatusPacket(host, port));
      } catch (err) {
        clearTimeout(timer);
        finish(err);
      }
    });

    socket.on('data', (chunk) => {
      chunks.push(chunk);

      const buffer = Buffer.concat(chunks);

      try {
        const packetLengthInfo = readVarInt(buffer, 0);
        const packetLength = packetLengthInfo.value;
        const packetStart = packetLengthInfo.size;

        if (buffer.length < packetStart + packetLength) return;

        const packet = buffer.subarray(
          packetStart,
          packetStart + packetLength
        );

        const packetIdInfo = readVarInt(packet, 0);

        if (packetIdInfo.value !== 0x00) {
          throw new Error(`Unexpected status packet id: ${packetIdInfo.value}`);
        }

        const jsonLengthInfo = readVarInt(packet, packetIdInfo.size);
        const jsonStart = packetIdInfo.size + jsonLengthInfo.size;
        const jsonEnd = jsonStart + jsonLengthInfo.value;

        if (jsonEnd > packet.length) {
          throw new Error('Incomplete status JSON');
        }

        const jsonText = packet.subarray(jsonStart, jsonEnd).toString('utf8');
        const data = JSON.parse(jsonText);

        clearTimeout(timer);
        finish(null, {
          online: true,
          host,
          resolvedAddress: address,
          port,
          playersOnline: Number(data?.players?.online) || 0,
          playersMax: Number(data?.players?.max) || 0,
          version: data?.version?.name || null,
          description: data?.description || null,
          raw: data,
        });
      } catch (err) {
        // Only finish on actual parse/protocol errors.
        // If the packet is merely incomplete, wait for more data.
        if (!/Incomplete|Unexpected status packet/i.test(err.message)) {
          clearTimeout(timer);
          finish(err);
        }
      }
    });

    socket.connect(port, host);
  });
}

async function checkServer() {
  if (!state.ip) {
    throw new Error('Minecraft IP is not set');
  }

  const result = await pingMinecraftServer(state.ip, state.port);

  state.lastServerCheck = new Date().toISOString();
  state.lastServerOnline = true;
  state.lastPlayerCount = result.playersOnline;

  return result;
}

async function checkServerSafe() {
  try {
    const result = await checkServer();
    return {
      success: true,
      ...result,
    };
  } catch (err) {
    state.lastServerCheck = new Date().toISOString();
    state.lastServerOnline = false;
    state.lastPlayerCount = null;

    return {
      success: false,
      error: err.message,
      online: false,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Anti-AFK actions
// ─────────────────────────────────────────────────────────────────────────────

function startAutoJump() {
  if (!state.bot || !state.connected) return false;

  if (state.sneakActive) {
    try {
      state.bot.setControlState('sneak', false);
    } catch (_) {}
    state.sneakActive = false;
  }

  if (state.jumpInterval) {
    clearInterval(state.jumpInterval);
  }

  state.jumpInterval = setInterval(() => {
    if (!state.bot || !state.connected) return;

    try {
      state.bot.setControlState('jump', true);

      setTimeout(() => {
        if (state.bot && state.connected) {
          try {
            state.bot.setControlState('jump', false);
          } catch (_) {}
        }
      }, 200);
    } catch (_) {}
  }, 3000);

  log('Auto-jump started');
  return true;
}

function startAutoMove() {
  if (!state.bot || !state.connected) return false;

  const directions = ['forward', 'back', 'left', 'right'];
  let currentDir = null;

  if (state.moveInterval) {
    clearInterval(state.moveInterval);
  }

  state.moveInterval = setInterval(() => {
    if (!state.bot || !state.connected) return;

    try {
      if (currentDir) {
        state.bot.setControlState(currentDir, false);
      }

      currentDir = directions[Math.floor(Math.random() * directions.length)];
      state.bot.setControlState(currentDir, true);
    } catch (_) {}
  }, 1000);

  log('Auto-move started');
  return true;
}

function startSneak() {
  if (!state.bot || !state.connected) return false;

  if (state.jumpInterval) {
    clearInterval(state.jumpInterval);
    state.jumpInterval = null;
  }

  try {
    state.bot.setControlState('sneak', true);
    state.sneakActive = true;
  } catch (_) {
    return false;
  }

  log('Sneak started');
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Player-aware monitoring
// ─────────────────────────────────────────────────────────────────────────────

function startLowPlayerMonitor() {
  if (!state.autoReconnect) {
    log('Not starting 1-minute monitor because monitoring is disabled');
    return;
  }

  if (state.connected) {
    stopPlayerMonitor();
    return;
  }

  if (state.monitorActive) {
    return;
  }

  state.monitorActive = true;
  log('Starting 1-minute player monitor; waiting for fewer than 3 players');

  const tick = async () => {
    if (!state.monitorActive || !state.autoReconnect) {
      stopPlayerMonitor();
      return;
    }

    if (state.connected) {
      stopPlayerMonitor();
      return;
    }

    const result = await checkServerSafe();

    if (!state.monitorActive || !state.autoReconnect) {
      return;
    }

    if (!result.success) {
      log(`Server check failed/offline during monitor: ${result.error}`);
    } else {
      log(`Monitor check: ${result.playersOnline} player(s) online`);

      if (result.playersOnline < JOIN_PLAYER_LIMIT) {
        stopPlayerMonitor();
        log('Player count is below 3; attempting bot join');
        attemptBotJoin();
        return;
      }
    }

    if (state.monitorActive && state.autoReconnect && !state.connected) {
      state.monitorTimer = setTimeout(tick, WAIT_CHECK_MS);
    }
  };

  tick();
}

function startBotPlayerChecker() {
  stopBotPlayerChecker();

  if (!state.connected || !state.autoReconnect) return;

  state.botCheckTimer = setInterval(async () => {
    if (!state.connected || !state.bot || !state.autoReconnect) {
      stopBotPlayerChecker();
      return;
    }

    const result = await checkServerSafe();

    if (!result.success) {
      log(`5-minute player check failed: ${result.error}`);
      return;
    }

    log(`5-minute player check: ${result.playersOnline} player(s) online`);

    if (result.playersOnline > LEAVE_PLAYER_LIMIT) {
      log(
        `Player count is above 4 (${result.playersOnline}); leaving server and returning to 1-minute monitor`
      );

      stopBotConnection(
        'Player count exceeded 4; switching to player monitor',
        true
      );

      startLowPlayerMonitor();
    }
  }, BOT_CHECK_MS);
}

// ─────────────────────────────────────────────────────────────────────────────
// Bot lifecycle
// ─────────────────────────────────────────────────────────────────────────────

function cleanupBotObject(quitReason = null) {
  if (!state.bot) {
    state.connected = false;
    clearAllActions();
    return;
  }

  const oldBot = state.bot;

  state.bot = null;
  state.connected = false;

  clearAllActions();

  try {
    oldBot.removeAllListeners();
  } catch (_) {}

  if (quitReason) {
    try {
      oldBot.quit(quitReason);
    } catch (_) {
      try {
        oldBot.end();
      } catch (_) {}
    }
  }
}

function stopBotConnection(reason = 'Stopped', continueMonitoring = false) {
  clearReconnectTimer();
  stopBotPlayerChecker();
  clearAllActions();

  const oldBot = state.bot;

  state.bot = null;
  state.connected = false;
  state.joinTime = null;

  if (oldBot) {
    try {
      oldBot.removeAllListeners();
    } catch (_) {}

    try {
      oldBot.quit(reason);
    } catch (_) {
      try {
        oldBot.end();
      } catch (_) {}
    }
  }

  log(`Bot stopped: ${reason}`);

  if (!continueMonitoring) {
    state.autoReconnect = false;
  }
}

function scheduleReconnect() {
  if (!state.autoReconnect) return;
  if (state.reconnectTimer) return;
  if (state.monitorActive) return;

  log('Scheduling bot reconnect in 15s...');

  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;

    if (state.autoReconnect && !state.connected) {
      log('Automatic bot reconnect attempt');
      attemptBotJoin();
    }
  }, 15000);
}

function createBot() {
  if (!state.ip) {
    state.lastError = 'Minecraft IP is not set';
    return false;
  }

  if (state.bot) {
    cleanupBotObject('Replacing existing bot connection');
  }

  log(
    `Connecting bot as ${state.botUsername} to ${state.ip}:${state.port}`
  );

  state.disconnectReason = null;
  state.lastError = null;

  try {
    state.bot = mineflayer.createBot({
      host: state.ip,
      port: state.port,
      username: state.botUsername,
      version: state.mcVersion || false,
      auth: state.mcAuth,
    });
  } catch (err) {
    state.lastError = err.message;
    log(`Failed to create bot: ${err.message}`);
    return false;
  }

  const bot = state.bot;

  bot.once('spawn', () => {
    if (state.bot !== bot) return;

    state.connected = true;
    state.joinTime = new Date();
    state.disconnectReason = null;
    state.lastError = null;

    stopPlayerMonitor();
    stopBotPlayerChecker();

    log(`Bot joined ${state.ip}:${state.port} as ${state.botUsername}`);

    // Start the 5-minute player-count checker.
    startBotPlayerChecker();
  });

  bot.on('error', (err) => {
    if (state.bot !== bot) return;

    state.lastError = err.message;
    log(`Bot error: ${err.message}`);
  });

  bot.on('kicked', (reason) => {
    if (state.bot !== bot) return;

    const wasConnected = state.connected;
    const banned = looksLikeBan(reason);

    state.connected = false;
    state.disconnectReason = reason;

    clearAllActions();
    stopBotPlayerChecker();

    log(`Bot kicked: ${normalizeText(reason)}`);

    if (!state.autoReconnect) {
      return;
    }

    if (banned) {
      const oldUsername = state.botUsername;
      state.botUsername = incrementUsername(oldUsername);

      log(
        `Bot banned as ${oldUsername}; trying different username: ${state.botUsername}`
      );

      // Remove this bot object before trying another username.
      try {
        bot.removeAllListeners();
      } catch (_) {}

      if (state.bot === bot) {
        state.bot = null;
      }

      state.connected = false;

      // Give the server a moment before the next login.
      state.reconnectTimer = setTimeout(() => {
        state.reconnectTimer = null;

        if (state.autoReconnect && !state.connected) {
          attemptBotJoin();
        }
      }, 2000);

      return;
    }

    // Ordinary kick, not identified as a ban.
    // Let the normal reconnect flow try again.
    if (wasConnected) {
      scheduleReconnect();
    } else {
      scheduleReconnect();
    }
  });

  bot.on('end', (reason) => {
    if (state.bot !== bot) return;

    const wasConnected = state.connected;

    state.connected = false;
    state.disconnectReason = reason;

    clearAllActions();
    stopBotPlayerChecker();

    log(`Bot connection ended: ${normalizeText(reason)}`);

    if (!state.autoReconnect) return;

    // If this was not a ban/kick path, reconnect normally.
    if (wasConnected) {
      scheduleReconnect();
    } else {
      scheduleReconnect();
    }
  });

  bot.on('death', () => {
    if (state.bot !== bot) return;

    log('Bot died — attempting respawn');

    try {
      bot.respawn();
    } catch (err) {
      log(`Respawn failed: ${err.message}`);
    }
  });

  return true;
}

async function attemptBotJoin() {
  if (!state.autoReconnect) {
    return {
      started: false,
      reason: 'Monitoring disabled',
    };
  }

  if (state.connected) {
    return {
      started: false,
      reason: 'Bot already connected',
    };
  }

  stopPlayerMonitor();
  clearReconnectTimer();

  const result = await checkServerSafe();

  if (!result.success) {
    log(`Server offline/unreachable: ${result.error}`);

    // Do not hammer an offline server.
    startLowPlayerMonitor();

    return {
      started: false,
      serverOnline: false,
      message: 'Server offline',
      error: result.error,
    };
  }

  log(
    `Server online: ${result.playersOnline}/${result.playersMax || '?'} player(s)`
  );

  if (result.playersOnline >= JOIN_PLAYER_LIMIT) {
    log(
      `${result.playersOnline} players online; bot will not join. Starting 1-minute monitor`
    );

    startLowPlayerMonitor();

    return {
      started: false,
      serverOnline: true,
      playersOnline: result.playersOnline,
      playersMax: result.playersMax,
      message: 'Server online but player count is 3 or higher; monitoring',
    };
  }

  // Fewer than 3 players: join now.
  log(
    `${result.playersOnline} player(s) online; below 3, attempting bot join as ${state.botUsername}`
  );

  const ok = createBot();

  if (!ok) {
    startLowPlayerMonitor();

    return {
      started: false,
      serverOnline: true,
      playersOnline: result.playersOnline,
      message: 'Failed to initialize bot',
      error: state.lastError,
    };
  }

  return {
    started: true,
    serverOnline: true,
    playersOnline: result.playersOnline,
    username: state.botUsername,
    message: 'Bot connection attempt started',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// /health
// UptimeRobot should use this endpoint.
// It intentionally contains no dashboard HTML.
// ─────────────────────────────────────────────────────────────────────────────

function healthResponse() {
  return {
    status: 'ok',
    service: 'Dertorrap Anti AFK Bot',
    botConnected: state.connected,
    monitoring: state.monitorActive,
    timestamp: new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP Router
// ─────────────────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const path = parsed.pathname.replace(/\/$/, '') || '/';
  const query = parsed.query;

  // /health is public for UptimeRobot.
  if (API_KEY && path !== '/health' && query.key !== API_KEY) {
    return jsonError(res, 401, 'Unauthorized. Pass ?key=YOUR_API_KEY');
  }

  // ── GET /health ───────────────────────────────────────────────────────────
  if (path === '/health' || path === '/') {
    return jsonOk(res, healthResponse());
  }

  // ── GET /status ───────────────────────────────────────────────────────────
  // Status page intentionally removed.
  if (path === '/status') {
    return jsonError(res, 404, 'Status endpoint removed. Use /health.');
  }

  // ── GET /ip?value=x ───────────────────────────────────────────────────────
  if (path === '/ip') {
    const value = query.value;

    if (!value) {
      return jsonError(res, 400, 'Missing ?value=<ip-address>');
    }

    state.ip = String(value).trim();

    log(`IP set to ${state.ip}`);

    return jsonOk(res, {
      message: `IP set to ${state.ip}`,
      ip: state.ip,
      port: state.port,
      readyToStart: state.portSet,
    });
  }

  // ── GET /port?value=x ─────────────────────────────────────────────────────
  if (path === '/port') {
    const p = Number.parseInt(query.value, 10);

    if (!query.value || Number.isNaN(p) || p < 1 || p > 65535) {
      return jsonError(
        res,
        400,
        'Missing or invalid ?value=<1-65535>'
      );
    }

    state.port = p;
    state.portSet = true;

    log(`Port set to ${state.port}`);

    return jsonOk(res, {
      message: `Port set to ${state.port}`,
      ip: state.ip,
      port: state.port,
      readyToStart: !!state.ip,
    });
  }

  // ── GET /rename?value=x ───────────────────────────────────────────────────
  if (path === '/rename') {
    const name = String(query.value || '');

    if (!name) {
      return jsonError(res, 400, 'Missing ?value=<username>');
    }

    if (name.length < 3 || name.length > 16) {
      return jsonError(
        res,
        400,
        'Username must be 3–16 characters'
      );
    }

    if (!/^[a-zA-Z0-9_]+$/.test(name)) {
      return jsonError(
        res,
        400,
        'Username can only contain a-z, 0-9, underscore'
      );
    }

    const old = state.botUsername;
    state.botUsername = name;

    log(`Bot username changed from ${old} to ${name}`);

    return jsonOk(res, {
      message: 'Bot username changed',
      oldUsername: old,
      newUsername: name,
      note: state.connected
        ? 'Use /stop then /start to apply'
        : 'Will apply on next connection attempt',
    });
  }

  // ── GET /version?value=x ──────────────────────────────────────────────────
  if (path === '/version') {
    const version = String(query.value || '');

    if (!version) {
      return jsonError(
        res,
        400,
        'Missing ?value=<version> e.g. 1.20.1 or auto'
      );
    }

    if (version === 'auto') {
      state.mcVersion = null;
      log('MC version reset to auto-detect');

      return jsonOk(res, {
        message: 'Version reset to auto-detect',
        version: 'auto-detect',
      });
    }

    if (!/^\d+\.\d+(\.\d+)?$/.test(version)) {
      return jsonError(
        res,
        400,
        'Invalid version format. Use e.g. 1.20.1'
      );
    }

    state.mcVersion = version;
    log(`MC version set to ${version}`);

    return jsonOk(res, {
      message: `Version set to ${version}`,
      version,
    });
  }

  // ── GET /start ────────────────────────────────────────────────────────────
  if (path === '/start') {
    if (!state.ip && !state.portSet) {
      return jsonError(
        res,
        400,
        'Both IP and Port are not set',
        {
          hint: 'Hit /ip?value=x and /port?value=x first',
        }
      );
    }

    if (!state.ip) {
      return jsonError(
        res,
        400,
        'IP not set',
        {
          hint: 'Hit /ip?value=<address>',
          portAlreadySet: state.port,
        }
      );
    }

    if (!state.portSet) {
      return jsonError(
        res,
        400,
        'Port not set',
        {
          hint: 'Hit /port?value=25565',
          ipAlreadySet: state.ip,
        }
      );
    }

    if (state.connected) {
      return jsonError(
        res,
        409,
        'Bot is already connected',
        {
          server: `${state.ip}:${state.port}`,
          username: state.botUsername,
          hint: 'Hit /stop first',
        }
      );
    }

    // Starting means monitoring is enabled.
    state.autoReconnect = true;
    clearReconnectTimer();

    const result = await attemptBotJoin();

    if (!result.started && result.serverOnline === false) {
      return jsonError(
        res,
        503,
        'Server offline',
        result
      );
    }

    if (!result.started && result.playersOnline >= JOIN_PLAYER_LIMIT) {
      return jsonOk(res, {
        message: 'Server has 3 or more players; bot not joined',
        ...result,
        monitor: 'checking every 1 minute for fewer than 3 players',
      });
    }

    return jsonOk(res, {
      ...result,
      username: state.botUsername,
      autoReconnect: state.autoReconnect,
    });
  }

  // ── GET /stop ─────────────────────────────────────────────────────────────
  if (path === '/stop') {
    if (
      !state.bot &&
      !state.connected &&
      !state.monitorActive &&
      !state.botCheckTimer
    ) {
      state.autoReconnect = false;

      return jsonError(
        res,
        400,
        'Bot and monitoring are not running'
      );
    }

    state.autoReconnect = false;

    clearReconnectTimer();
    stopMonitoring();
    clearAllActions();

    const oldBot = state.bot;

    state.bot = null;
    state.connected = false;
    state.joinTime = null;

    if (oldBot) {
      try {
        oldBot.removeAllListeners();
      } catch (_) {}

      try {
        oldBot.quit('Stopped via API');
      } catch (_) {
        try {
          oldBot.end();
        } catch (_) {}
      }
    }

    log('Bot and all monitoring stopped via API');

    return jsonOk(res, {
      message: 'Bot stopped and monitoring stopped',
      autoReconnect: false,
      playerMonitor: false,
      botPlayerChecker: false,
    });
  }

  // ── GET /jump ─────────────────────────────────────────────────────────────
  if (path === '/jump') {
    if (!state.connected) {
      return jsonError(
        res,
        400,
        'Bot is not connected',
        { hint: 'Use /start first' }
      );
    }

    if (state.sneakActive) {
      try {
        state.bot.setControlState('sneak', false);
      } catch (_) {}

      state.sneakActive = false;
    }

    const ok = startAutoJump();

    if (!ok) {
      return jsonError(res, 500, 'Failed to start auto-jump');
    }

    return jsonOk(res, {
      message: 'Auto-jump started',
      intervalSeconds: 3,
      sneakStopped: true,
    });
  }

  // ── GET /move ─────────────────────────────────────────────────────────────
  if (path === '/move') {
    if (!state.connected) {
      return jsonError(
        res,
        400,
        'Bot is not connected',
        { hint: 'Use /start first' }
      );
    }

    const ok = startAutoMove();

    if (!ok) {
      return jsonError(res, 500, 'Failed to start auto-move');
    }

    return jsonOk(res, {
      message: 'Auto-move started',
      intervalSeconds: 1,
      directions: ['forward', 'back', 'left', 'right'],
    });
  }

  // ── GET /sneak ─────────────────────────────────────────────────────────────
  if (path === '/sneak') {
    if (!state.connected) {
      return jsonError(
        res,
        400,
        'Bot is not connected',
        { hint: 'Use /start first' }
      );
    }

    const ok = startSneak();

    if (!ok) {
      return jsonError(res, 500, 'Failed to start sneak');
    }

    return jsonOk(res, {
      message: 'Sneak mode activated',
      jumpStopped: true,
    });
  }

  // ── GET /stopaction ───────────────────────────────────────────────────────
  if (path === '/stopaction') {
    clearAllActions();
    log('All anti-AFK actions stopped via API');

    return jsonOk(res, {
      message: 'All actions stopped',
      jump: false,
      move: false,
      sneak: false,
    });
  }

  // ── GET /ping ──────────────────────────────────────────────────────────────
  // Useful for manually checking the server without starting the bot.
  if (path === '/ping') {
    if (!state.ip || !state.portSet) {
      return jsonError(
        res,
        400,
        'IP and Port must be configured first'
      );
    }

    const result = await checkServerSafe();

    if (!result.success) {
      return jsonError(res, 503, 'Server offline', result);
    }

    return jsonOk(res, {
      message: 'Server online',
      ip: state.ip,
      port: state.port,
      playersOnline: result.playersOnline,
      playersMax: result.playersMax,
      version: result.version,
    });
  }

  // ── 404 ───────────────────────────────────────────────────────────────────
  return jsonError(
    res,
    404,
    `Unknown endpoint: ${path}`,
    {
      availableEndpoints: [
        '/health',
        '/ping',
        '/start',
        '/stop',
        '/jump',
        '/move',
        '/sneak',
        '/stopaction',
        '/ip?value=x',
        '/port?value=x',
        '/rename?value=x',
        '/version?value=x',
      ],
    }
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Server
// ─────────────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log('');
  console.log('🛡️  DERTORRAP ANTI AFK BOT');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`🌐 HTTP server: port ${PORT}`);
  console.log(`❤️  Health:      /health`);
  console.log(`📡 Start:       /start`);
  console.log(`🛑 Stop:        /stop`);

  if (API_KEY) {
    console.log('🔒 API key protection: enabled');
  } else {
    console.log('⚠️  API key protection: disabled');
  }

  console.log('');
  log('Service started');
});

// ─────────────────────────────────────────────────────────────────────────────
// Process safety
// ─────────────────────────────────────────────────────────────────────────────

process.on('uncaughtException', (err) => {
  log(`Uncaught exception: ${err.message}`);
});

process.on('unhandledRejection', (reason) => {
  log(`Unhandled rejection: ${normalizeText(reason)}`);
});

process.on('SIGTERM', () => {
  log('SIGTERM received; shutting down');

  state.autoReconnect = false;
  stopMonitoring();
  clearReconnectTimer();
  clearAllActions();

  if (state.bot) {
    try {
      state.bot.quit('Process shutting down');
    } catch (_) {}
  }

  server.close(() => process.exit(0));

  setTimeout(() => process.exit(0), 5000).unref();
});

process.on('SIGINT', () => {
  log('SIGINT received; shutting down');

  state.autoReconnect = false;
  stopMonitoring();
  clearReconnectTimer();
  clearAllActions();

  if (state.bot) {
    try {
      state.bot.quit('Process shutting down');
    } catch (_) {}
  }

  server.close(() => process.exit(0));

  setTimeout(() => process.exit(0), 5000).unref();
});
