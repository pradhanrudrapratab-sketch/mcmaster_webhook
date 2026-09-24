# 🛡️ Dertorrap Anti-AFK Bot

A player-aware Minecraft Anti-AFK bot built with **Node.js + Mineflayer**.

The bot does not blindly join the Minecraft server. It checks the server first, watches the player count, joins when the server is quiet, and leaves when the server becomes busy.

## ✨ Features

- Minecraft server online/offline check before joining
- Player count check before bot login
- Joins when **fewer than 3 players** are online
- If 3 or more players are online, waits and checks every **1 minute**
- After joining, checks player count every **5 minutes**
- Leaves automatically when **more than 4 players** are online
- After leaving, returns to the 1-minute low-player monitor
- Automatic reconnect
- Ban detection
- Automatic username progression after a ban
- Example: `playez` → `playfa`
- Anti-AFK auto-jump
- Anti-AFK random movement
- Sneak mode
- HTTP API
- `/health` endpoint for UptimeRobot
- Optional API-key protection
- Graceful Render shutdown handling
- No database required

---

## 🧠 How the bot works

### `/start`

```text
/start
   │
   ▼
Check Minecraft server
   │
   ├── Offline
   │     └── Return "Server offline"
   │
   └── Online
          │
          ▼
      Check players
          │
          ├── 0–2 players
          │      └── Try to join
          │
          └── 3+ players
                 └── Check every 1 minute
                         │
                         └── <3 players
                                └── Try to join
```

### After the bot joins

```text
Bot connected
     │
     ▼
Check player count every 5 minutes
     │
     ├── 0–4 players
     │      └── Stay connected
     │
     └── 5+ players
            └── Leave server
                    │
                    ▼
             1-minute monitoring
                    │
                    ▼
                 <3 players
                    │
                    ▼
                Join again
```

This uses two different thresholds intentionally:

- **Join threshold:** fewer than 3 players
- **Leave threshold:** more than 4 players

This prevents constant join/leave cycling when the server is around 3–4 players.

---

## 🚫 Ban handling

If the Minecraft server kicks the bot with a ban-related message, the bot changes its username and tries again.

Example:

```text
playet
playeu
playev
...
playez
playfa
playfb
...
```

The username increment works like an alphabetic counter, so `z` rolls over and carries to the previous letter.

A normal network error or ordinary disconnect does **not** automatically consume a new username.

---

## 🔗 API Endpoints

### Health

```text
GET /health
```

Used by UptimeRobot.

Example:

```text
https://YOUR-RENDER-DOMAIN/health
```

Returns a small JSON health response.

---

### Start

```text
GET /start
```

Starts the player-aware monitoring system.

The bot checks:

1. Is the Minecraft server online?
2. How many players are online?
3. If fewer than 3 → attempt to join.
4. Otherwise → monitor every minute.

If `API_KEY` is configured:

```text
/start?key=YOUR_API_KEY
```

---

### Stop

```text
GET /stop
```

Stops:

- Minecraft bot
- automatic reconnect
- 1-minute player monitor
- 5-minute player checker
- anti-AFK actions

---

### Server ping

```text
GET /ping
```

Checks the Minecraft server without starting the bot.

Returns:

- online/offline
- current player count
- maximum players
- Minecraft version

---

### Set Minecraft IP

```text
GET /ip?value=example.com
```

### Set Minecraft port

```text
GET /port?value=25565
```

### Change bot username

```text
GET /rename?value=BotPlayer
```

### Set Minecraft version

```text
GET /version?value=1.20.1
```

or:

```text
/version?value=auto
```

---

## 🎮 Anti-AFK controls

### Auto-jump

```text
GET /jump
```

The bot jumps periodically.

### Auto-movement

```text
GET /move
```

The bot randomly changes between:

```text
forward
back
left
right
```

### Sneak

```text
GET /sneak
```

### Stop actions

```text
GET /stopaction
```

Stops jump, movement, and sneak.

---

## 🔐 API Security

Set an API key in Render:

```text
API_KEY=your-long-random-secret
```

`/health` remains public so UptimeRobot can monitor it.

Other endpoints require:

```text
?key=YOUR_API_KEY
```

Example:

```text
https://YOUR-RENDER-DOMAIN/start?key=YOUR_API_KEY
```

For production use, use a long random API key and do not share it publicly.

---

## ☁️ Deploy on Render

### 1. Upload the project to GitHub

The project should contain:

```text
dertorrapp/
├── index.js
├── package.json
├── Procfile
├── README.md
└── .env.example
```

### 2. Create a Render Web Service

Use your GitHub repository.

### 3. Build command

```bash
npm install
```

### 4. Start command

You can use:

```bash
npm start
```

or let Render use the included `Procfile`.

### 5. Environment variables

Set:

```text
MC_IP=your.minecraft.server
MC_PORT=25565
MC_USERNAME=BotPlayer
MC_AUTH=offline
```

Optional:

```text
MC_VERSION=1.20.1
API_KEY=your-secret-key
```

Render provides `PORT` automatically.

---

## ❤️ UptimeRobot

Create an HTTP monitor pointing to:

```text
https://YOUR-RENDER-DOMAIN/health
```

The endpoint intentionally stays lightweight and does not expose the old dashboard.

---

## 📋 Example workflow

Configure:

```text
/ip?value=play.example.com
/port?value=25565
/rename?value=playet
```

Then:

```text
/start
```

If the server has:

```text
2 players
```

the bot attempts to join.

If it has:

```text
4 players
```

the bot waits and checks again in 1 minute.

If the bot is connected and after a 5-minute check the server has:

```text
5 players
```

the bot leaves and returns to 1-minute monitoring.

---

## ⚙️ Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | No | `3000` | HTTP server port; Render supplies this |
| `API_KEY` | No | None | Protects control endpoints |
| `MC_IP` | No | None | Minecraft server address |
| `MC_PORT` | No | `25565` | Minecraft server port |
| `MC_USERNAME` | No | `BotPlayer` | Initial bot username |
| `MC_VERSION` | No | Auto | Mineflayer Minecraft version |
| `MC_AUTH` | No | `offline` | Mineflayer authentication mode |

---

## 📦 Local installation

```bash
npm install
npm start
```

The HTTP server will listen on the configured `PORT`.

---

## ⚠️ Notes

The server-status check uses the Minecraft Server List Ping protocol before creating the Mineflayer bot.

The exact ban detection depends on the kick message returned by the Minecraft server. If a server uses a custom ban message that does not contain recognizable ban-related wording, it may be treated as a normal kick instead of a ban.

The bot's player-count checks are server-status queries and do not require the bot to be connected for the monitoring phase.

---

## 🛡️ Project

**Dertorrap Anti-AFK Bot**

Built with:

- Node.js
- Mineflayer
- Minecraft Server List Ping
- HTTP API
- Render

