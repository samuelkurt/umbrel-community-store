# Blockhaus Solo

The Blockhaus panel (see `../samuelkurt-blockhaus/README.md` for every page) with its **own Minecraft engine**:
no Crafty Controller. Blockhaus starts the Java process, reads its console, pings it and stops it cleanly.
The code is the same as in Blockhaus; `src/` here is a copy made by `node scripts/sync-solo.js` from the store root.
Since 0.7.0 it has the **Anticheat** page (never acts by itself; manual buttons on each finding, see the Blockhaus README); the Crafty app does not.

## What differs from Blockhaus (with Crafty)

| | Blockhaus + Crafty | Blockhaus Solo |
|---|---|---|
| Who runs Minecraft | Crafty | Blockhaus (`src/lib/local.js`) |
| Java | the one in Crafty's container | Temurin JRE, downloaded on first start into `data/java/<major>` (checksum from the Adoptium API). 8, 11, 17, 21 or 25, chosen from the server (`java_version` in the jar, the installer record, or the Minecraft version); can be set per server |
| Servers | the ones Crafty has | **Meine Server** page: create (Vanilla, Paper, Purpur, Fabric, Quilt, NeoForge, Forge), take over a folder, rename, memory, autostart, remove (files stay) |
| Running at once | whatever Crafty allows | one server (one published Minecraft port) |
| Minecraft port | 25565 in Crafty | **25665 TCP**, written into `server-port` of the server that starts |
| Voice chat | needs a port Crafty publishes (UDP 19132 suggested) | **UDP 24454** is published by the app, the mod's default |
| Texture-pack port | 25700 | 25701 |
| Image | `node:22-alpine` | `node:22-bookworm-slim` (Temurin is built for glibc) |
| Stop | Crafty | `stop` on the console, kill after 90 s; `docker stop` waits up to 2 minutes (`stop_grace_period`) so the world is saved |
| EULA | Crafty / you | you accept it once per server in the panel (it writes `eula.txt`); Blockhaus never does that silently |

None of the published ports lies in Crafty's 25500-25600 range, and they differ from Blockhaus (25700), so the three
apps can be installed together (`src/test/compose.test.js` checks this; it is the mistake that broke the 0.4.0 install).

## Install

1. Install **Blockhaus Solo** from this store. The app folder is `~/umbrel/app-data/samuelkurt-blockhaus-solo/`
   (servers in `servers/`, settings and Java in `data/`).
2. Open the tile: **Meine Server**. Create a server (name, memory, software, version), accept the EULA on the Server page,
   press **Starten**. The first start downloads Java (some dozens of MB); the console shows it. Forge/NeoForge/Quilt
   additionally run their installer once (internet, a few minutes).
3. Friends: in the playit.gg app's dashboard a **TCP** tunnel to `127.0.0.1:25665` (the agent runs in host networking).
   Put its address into Einstellungen → Öffentliche Adresse.
4. Voice chat: a **UDP** tunnel ("MC: Simple Voice Chat") to `127.0.0.1:24454`, its address as `voice_host` on the Voice Chat page.
   The free playit plan has four ports in total.

### Taking over a server from Crafty
Stop it in Crafty, then copy its folder (this is a copy; Crafty's folder stays untouched):

```bash
sudo cp -a ~/umbrel/app-data/denny-crafty/data/servers/<SERVER-ID> ~/umbrel/app-data/samuelkurt-blockhaus-solo/servers/mein-server
```

Open **Meine Server** → Aktualisieren → Übernehmen. For a server installed with Blockhaus the start file is recognised
from `.blockhaus-software.json`; otherwise you pick the jar. When it starts, `server-port` is changed to 25665
(`server.properties.blockhaus.bak` keeps the old file). Do not start the same folder in Crafty and in Solo at once.
If your Umbrel root is not `~/umbrel`, the page shows the real folder.

## Limits

- One running server. A second one has to wait ("Es läuft schon ein anderer Server").
- Blockhaus restarts do not keep Minecraft alive: a restart of the app (also an Umbrel update of it) stops the server
  cleanly and, with autostart on, starts it again.
- Minecraft is started with `-Xmx<memory>` and `-Dfile.encoding=UTF-8` only; there is no field for further JVM flags.
- Unsupported on purpose, as in Blockhaus: Spigot (use Paper).

## Verified and not verified

Verified here (real, not mocked):
- Real Minecraft **Vanilla 26.3**: download from Mojang through the panel's install job, Java 25 fetched from the real
  Adoptium API and unpacked, server started by the panel, online after 20 s on this machine, version / max players / MOTD
  from Server List Ping, memory read from `/proc`, a console command executed, clean stop (exit code 0, world saved).
- Real **Forge 26.3 (66.0.13)**, the same build as your server, from an empty folder: installer downloaded, the launcher
  ran the Forge installer once, the server was online after 39 s, a console command ran, clean stop with exit code 0.
- Process manager against a fake Java with every state: starting, online, players via log and ping, stop, crash
  (exit code ≠ 0), restart, a server that ignores `stop` (killed after the timeout, child process too), kill, Java
  download failing or being cancelled, one-at-a-time rule, SIGTERM-style shutdown, autostart, EULA gate.
- HTTP API and the browser UI (desktop and phone width) in standalone mode, end to end.
- Compose: the YAML parses (`docker compose config`); the published ports are checked against Crafty's range and each other.
- Java downloader against a fake Adoptium server (checksum failure, missing `bin/java`, no build for the CPU) and the real one.

Not verified: anything inside a real Umbrel/Docker (no Docker daemon here): that `node:22-bookworm-slim` has `tar` and the
libraries Temurin needs (both are standard on Debian, but untested), that Umbrel accepts ports 25665/24454/25701,
`docker stop` timing on umbrelOS, ARM (the downloader asks for `aarch64` and Adoptium lists it, nothing was run), your
existing Forge world, voice chat and playit through the tunnels, Paper/Purpur/Fabric/Quilt/NeoForge started by the new
process manager (their installs were verified earlier in Blockhaus; only Vanilla and Forge ran under the new process manager).

## Tests

```bash
cd ../samuelkurt-blockhaus/src && node --test test/*.test.js
```
