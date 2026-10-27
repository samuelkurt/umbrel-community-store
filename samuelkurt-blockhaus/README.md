# Blockhaus

German-language, Aternos-style panel for a Minecraft server managed by Crafty Controller 4.
Owner only, no public page. Friends connect with the normal Minecraft address.

> **0.5.0 / 0.6.0 / 0.7.0:** the same panel also exists as **Blockhaus Solo** (`../samuelkurt-blockhaus-solo`), which starts Minecraft
> itself and needs no Crafty. Install either this app (with Crafty) or Solo; both can be installed next to each other
> (their ports differ), but should not run the *same* server folder at the same time. The code is shared:
> `node scripts/sync-solo.js` copies `src/` to the Solo folder (a test fails when the copies differ).

## What is in this version (0.7.0)

| Page | What it does |
|---|---|
| Server | Status (Offline / Startet / Online / Stoppt / Abgestürzt), Start, Stop, Restart, force stop, address card with copy button, software, version, memory, world, players online |
| Optionen | Aternos-style cards for the common `server.properties` keys (game mode, difficulty, whitelist, "Gecrackt", seed, view distance, resource pack URL/SHA-1/required, ...) plus an editor for every other key. Unchanged lines stay byte-identical, a `server.properties.blockhaus.bak` is kept |
| Spieler | Whitelist, operators, banned players, banned IPs. Kick / op / ban for players who are online |
| Konsole | Live server output, command line with history |
| Log | `logs/latest.log` and older `.log` / `.log.gz` files, text filter, warnings-only filter |
| Inventare | Every player's saved inventory, armor, off-hand, ender chest, health/hunger/level/position (read from `playerdata/*.dat`). For online players "Live vom Server holen" asks the running server (`data get entity`) |
| Dateien | File manager for the server folder: browse, edit text files, upload (button or drag and drop), download, rename, mkdir, delete. Paths are confined to the server folder |
| Welten | List with seed, version, game mode, size. Create a new world (name, seed, type, structures), upload a world ZIP (level.dat may be in a subfolder), download a world as ZIP, switch the active world, delete inactive ones. Nether / End folders are handled together |
| Backups | Worlds or the whole server as ZIP into this app's data folder. Running servers get `save-off` / `save-all flush` first. Restore (takes a safety backup first), download, delete, plus an optional "also trigger Crafty's own backup" |
| Software | Switch between Vanilla, Snapshot, Paper, Purpur, Fabric, Quilt, NeoForge, Forge and any Minecraft version they support. Downloads are checked against the vendor checksum where one exists. Optional world backup first. On a running server it can stop the server, switch and start it again (checkboxes) |
| Mods & Plugins | List `mods/` or `plugins/` (by the installed software), enable/disable, delete, upload a jar, search Modrinth and install with required dependencies (sha512 checked). Tab "Schneller": a curated list of performance mods (Lithium, FerriteCore, ServerCore, ModernFix, Ksyxis, Clumps, Chunky, spark, ...) that shows only what Modrinth really has for your loader and Minecraft version, with a hint when the other loader has more |
| Texturpakete | Upload several resource-pack ZIPs, order them, publish them as one bundle that your players download directly from Blockhaus. Checks every ZIP (see below) |
| Voice Chat | Finds Simple Voice Chat in `mods/`/`plugins/`, shows its config and the port from the server log, and sets `port` and `voice_host` in `config/voicechat/voicechat-server.properties` (rest of the file untouched, `.blockhaus.bak` kept). Explains the three things a tunnel setup needs (see below) |
| Leistung *(dedicated-server mode only)* | Computer performance: CPU, memory, load, temperature, power draw in watts (RAPL / GPU hwmon / battery; not measured at the plug), network, disk throughput and space, per-core load, biggest processes, and the share used by Minecraft; history up to 1 h |
| Terminal *(dedicated-server mode only)* | A real shell in the browser (several tabs, survives closing the page, replay of the last screen, key bar for phones) |
| Anticheat *(Solo and dedicated server only)* | Server-side, **records and never acts by itself** (no automatic kick, ban or warning; manual buttons on each finding). Flags impossible items (bedrock, command blocks, spawners, spawn eggs, enchantments above vanilla maximum, stacks above the maximum, unbreakable items; also inside shulker boxes and bundles), speed, large jumps and flying/hovering of online players, chat spam, connection floods, many names per address, vanilla warnings (`moved too quickly`, floating kicks) and x-ray hints from the statistics. Optional allow-lists (file name + SHA-256) for mods/plugins and for the server's texture pack. Points per player that fade over time, warnings on the page and a counter in the menu. Operators are exempt by default. See "Anticheat" below |
| Einstellungen | Version of Blockhaus, Crafty URL, API token (or user + password), public address to show friends, connection test |

### Texture packs

Vanilla supports **one** server pack (`resource-pack` in `server.properties`) and the players' clients download it
from a URL. Blockhaus therefore:

1. stores your uploaded ZIPs, checks each one and repairs a wrongly packed one (the `pack.mcmeta` lying in a subfolder),
2. merges the enabled ones into one ZIP (top of the list wins; `lang/*.json`, `sounds.json` and `atlases/*.json` are
   combined instead of overwritten),
3. publishes it as `<server>-<sha1>.zip` (a changed pack always gets a new URL) and writes `resource-pack`,
   `resource-pack-sha1` and `resource-pack-id` into `server.properties`. A restart is needed.

**Why a pack can download but not apply.** The client reads the `pack.mcmeta` of a downloaded server pack and, if it is
invalid, silently ignores the pack (log: "Invalid pack metadata ..., ignoring all"), with no message in game. Checked
against the real Minecraft 26.3 code: this happens for a missing `pack.mcmeta` at the ZIP root, a missing `description`,
and for packs for newer versions that use `pack_format` where 26.x requires `min_format` / `max_format` (or the other way
round). A *too old* `pack_format` alone does **not** stop a server pack from loading. When the top pack would be
ignored on your server's version, Blockhaus rewrites the format fields of the published bundle (and says so).
`src/test/java-verify/` has the scripts that compare this logic with the real parser.

**"Von Hand eingetragene Adresse".** If `server.properties` already has a `resource-pack` URL that Blockhaus did not publish (typical:
typed in under Optionen), the Texturpakete page shows it and can *check* it: Blockhaus downloads the file from that
address and reports what a client would do with it (webpage instead of ZIP, SHA-1 does not match the file, `pack.mcmeta`
in a subfolder or invalid for 26.x, over 250 MB). "In meine Pakete übernehmen" then imports that file into the library
(repaired if needed). A server log line `resource-pack-id missing` means such a hand-entered address is in use; pack
hosting by Blockhaus always writes an id.

**Second tunnel (recommended) or tunnel switch.** The pack port can be reached over a *second* playit tunnel (Custom TCP,
local 127.0.0.1:25700, address entered as "Download-Adresse für Pakete" in the settings); Minecraft then stays untouched.
The other way is the single-tunnel setup below.

**How the download reaches your friends (single tunnel).** Blockhaus listens on port 25700 (not 25566: Crafty publishes 25500-25600, so any port in that range makes the install fail; published by the compose file, not behind
the Umbrel login) and answers `GET /p/<file>.zip` for published packs only. Everything that is not HTTP is forwarded
unchanged to Crafty (setting "Minecraft-Server für die Weiterleitung", default `host.docker.internal:25565`). So in the
**playit.gg dashboard change the local port of your Minecraft tunnel from 25565 to 25700**: the same public address then
serves Minecraft and the pack. The pack URL is `http://<public address>/p/<file>.zip`, built from the public address
in the settings (or the optional pack address). Direct connections to 25565 (LAN, Tailscale) are unaffected, but while
the tunnel points at 25700 friends cannot join via playit if Blockhaus is down. "Von außen testen" downloads the pack
through the public address and compares the SHA-1.

Packs must stay under 250 MB after merging (the client's limit).

Not supported on purpose: **Spigot** (it has to be compiled with BuildTools; use Paper, which runs
Spigot plugins) and the Aternos "Zugriff" / sharing page.

## Install

1. Publish the store repo (see the README one folder up) and install **Blockhaus** from it.
   The compose file mounts Crafty's servers folder from
   `${UMBREL_ROOT}/app-data/denny-crafty/data/servers`. If your Crafty app has another id,
   change that line in `docker-compose.yml`.
2. Open the tile. The first screen is **Einstellungen**.
3. In Crafty create an API key for your user (Crafty has this under your user profile; menu
   names may differ by version). It needs access to your server and the right to run commands,
   start/stop and read logs. Paste it into the panel, press **Verbindung testen**, then **Speichern**.
   Alternatively enter your Crafty username and password under "Statt Token".
4. Enter your public address (for example the playit.gg one) so the Server page can show it.

If the test says Crafty is unreachable, try `https://host.docker.internal:8443` as the Crafty URL
(the compose file adds that name), or `https://<Umbrel-IP>:8443`.

The settings, including the token, live in `app-data/samuelkurt-blockhaus/data/config.json`
(mode 600). They are never part of this repository.

## How it works

- Start/stop/console/status go through Crafty's API v2.
- `server.properties`, the player lists and logs are read from the server folder directly.
- While the server runs, player-list changes are sent as console commands (`whitelist add`,
  `ban`, ...), because the server keeps these lists in memory and would overwrite file edits.
  While it is stopped, the JSON files are edited directly (UUID from Mojang's API, or the offline
  UUID if `online-mode=false`).
- Changing `server.properties` only takes effect after a restart. The panel says so.
- The container runs as root so it can write into the server folder, and it copies the owner and
  mode of the file it replaces.

### Voice chat behind playit.gg
Simple Voice Chat does not use the Minecraft connection. The server opens a **UDP** port (default 24454) and tells
clients to use `voice_host`, or, if that is empty, the address they joined with. Three things are needed: a UDP port that
Crafty publishes to the host, a UDP tunnel in playit.gg (protocol "MC: Simple Voice Chat", local 127.0.0.1) that points at
it, and `voice_host=<playit address:port>`. The Crafty app in Denny's store (read from its `docker-compose.yml` on GitHub,
not from your machine) publishes TCP 25500-25600 and UDP 19132 only, so Blockhaus suggests setting the voice port to
19132 (the Bedrock port). Everything on the Voice Chat page is an edit of the two config values; the tunnel is made in
the playit dashboard.

### Software switching

Crafty starts the server with `java ... -jar <executable> nogui`, and its API cannot change that command.
So Blockhaus **replaces the jar file itself** (the old one stays as `<jar>.blockhaus-prev`).
Vanilla, Paper, Purpur and Fabric ship a ready server jar. Quilt, Forge and NeoForge only have an
installer, so the jar is replaced by a tiny launcher (`src/assets/blockhaus-launcher.jar`, source in
`src/assets/launcher/`). On the first start it runs the installer with Crafty's own Java, then
starts the real server with the same Java and memory flags. What is installed is recorded in
`.blockhaus-software.json`.

**Java:** newer Minecraft versions need newer Java (1.21.x: 21, 26.x: 25). The panel tells you which one
a version needs, but the Java Crafty uses is set in Crafty (server configuration / its Java setting).
A too-old Java makes the server fail to start.

## Dedicated-server mode (Debian, without UmbrelOS)

`BLOCKHAUS_MODE=local` plus `BLOCKHAUS_HOST=1` runs the panel directly on a Debian/Ubuntu server and adds the pages
**Leistung** and **Terminal** and an own login (Umbrel's login is not there). Everything is in
[`../deploy/debian`](../deploy/debian/README-DEBIAN.md): `install.sh` (also updates), `uninstall.sh`,
`import-from-umbrel.sh`, the systemd unit, and a German guide with the security model. Short version:

- `BLOCKHAUS_HOST=1` turns on login + Leistung + Terminal; `BLOCKHAUS_AUTH=1` turns on only the login; `BIND` sets the listen address.
- The password is set only from the command line (`node server.js --set-password`, or `blockhaus-passwd`), stored as an scrypt hash, and a changed password ends every open session.
- The terminal is a shell of the service user (an unprivileged user without sudo). The panel speaks plain HTTP: use it in a trusted network, over VPN or an SSH tunnel, never port-forwarded.
- Without these variables (Umbrel) nothing changes: no login, no host routes (tested).

## Limits

- ZIPs: no ZIP64, so under 65,535 files and under 4 GB per backup / world upload.
- Uploads go through Umbrel's app proxy; very large files may be refused there. Put them into the
  server folder via SMB/SSH instead.
- Mutating actions (restore, switch world, delete world) need a stopped server and say so. Switching software can stop and restart the server itself.

## Verified and not verified

Verified (automated, with real data): texture-pack checks and the published bundle against the real Minecraft 26.3 pack loader (`Pack.readPackMetadata`, the call the client uses for server packs); server.properties round trips; NBT parsing of a real 1.21.4
`level.dat` and `playerdata`; live inventory equals file inventory on a real server; real installs and
starts of Vanilla, Paper, Purpur, Fabric, Quilt, Forge and NeoForge for 1.21.4; Modrinth search /
install / dependencies; ZIP interop with `zip` / `unzip`; browser click-through of every page on
desktop and phone width.

Dedicated-server mode (verified on Ubuntu 24.04 with the real installer and the unprivileged service user; details and limits in `deploy/debian/README-DEBIAN.md`): login with lockout, sessions, WebSocket terminal on a real pseudo terminal, host statistics from `/proc` and `/sys`, a real Minecraft 26.3 start and clean stop on SIGTERM, migration from Umbrel data, browser click-through in Chromium. Not verified there: running under a live systemd, a real Debian, ARM, a temperature sensor, and the power-draw card on real hardware (only against a fake `/sys`).

Not verified: that voice chat then connects through playit (no client or tunnel here; the Crafty port list comes from a GitHub file and your installed version may differ), that the performance mods run on your server (only that Modrinth lists a release for your loader and version), the pack download through the real playit.gg tunnel (HTTP over a tunnel meant for Minecraft, use "Von außen testen"), Umbrel accepting the extra published port, a real Minecraft client applying the pack, pack rules of Minecraft versions older than 26.x (the repair is only applied for 26.x), the real Crafty (API shapes come from its OpenAPI docs, tests use a mock), the Java
version of your Crafty, large uploads through Umbrel's proxy, the seed location in 26.x worlds,
inventories of other Minecraft versions than 1.21.4 (the old pre-1.20.5 item format is only covered
by a synthetic test), Forge/NeoForge/Quilt on versions other than 1.21.4.

## Tests

```bash
cd src && node --test test/*.test.js
```

The offline tests run against a mock of the Crafty API (`src/test/mock-crafty.js`) and a temporary
server folder, with real fixtures from a 1.21.4 server in `src/test/fixtures`. They do not talk to a real Crafty.

Standalone-mode tests (`local.test.js`, `local-api.test.js`, `solo-base.test.js`) use a fake `java` (`src/test/fake-mc.js`).
`NET=1` also runs the real Adoptium download.

```bash
NET=1 node --test test/net.test.js   # real Mojang / Paper / Purpur / Fabric / Quilt / Forge / NeoForge / Modrinth
```

downloads a few hundred MB and needs internet.

### Anticheat (Blockhaus Solo and dedicated server)

It runs inside Blockhaus and only works when Blockhaus starts Minecraft itself, because it needs the live console. In the
Crafty app the page is not shown. Nothing happens by itself: nobody is kicked, banned or warned automatically. Findings are listed on the
page and counted next to the menu entry, and every finding has **manual buttons** (see below). Records are stored in `<data>/anticheat/<server>/` (`config.json`, `flags.json`).

Manual actions (0.7.1; each needs a click and, where it destroys something, a confirmation):

- **Item entfernen / Behälter entfernen** for item findings: before anything happens Blockhaus asks the server what lies in that slot *now* (`data get entity <name> Inventory[{Slot:Nb}].id`, `EnderItems[...]`, `equipment.<slot>`); only if it is still the flagged item, `item replace entity <name> <slot> with minecraft:air` runs, and a second query confirms the slot is empty. A copy of the stack (NBT) is stored in the finding. For an item inside a shulker box or bundle the whole container is removed. If the player is offline the removal is queued and runs about 4 s after they join. Verified on a real 26.3 server for inventory, helmet, offhand, ender chest, a shulker box with bedrock inside, and the queued case.
- **Verwarnen** (`tell`), **Kicken**, **Bannen** (reason is entered by you; line breaks are removed), **Zurücksetzen** (after "Großer Sprung": back to the last position and dimension), **Adresse sperren** (`ban-ip`, for connection floods; shared home-network addresses affect everyone behind them), **Mod abschalten** (renames the file to `.disabled`, restart needed).
- Players are addressed by name only if the name is certain; findings that only know a player id offer no player actions. Unban in the players list.

How it sees things (checked against a real Minecraft 26.3 server):

- **Console lines**: logins with address, chat, the server's own warnings, kicks. Chat text is never interpreted as a server message.
- **Player data / statistics files** (`world/players/data`, `world/players/stats`): items and x-ray hints. New data appears when the server saves or the player leaves.
- **Queries** (only the speed and flying checks): for every online, non-exempt player Blockhaus sends `data get entity <name> Pos|OnGround|Dimension`
  every 5 s, and on suspicion `RootVehicle`, `FallFlying`, `playerGameType`, `abilities`, `active_effects`, `Health` and one `execute ... if block` test.
  The answers are removed from Blockhaus' console view, **but the server still writes them to `logs/latest.log`**. Switch off "Geschwindigkeit" and "Fliegen" for a quiet log.
  Vehicles, elytra, creative/spectator, flight permission, Speed potions, levitation, water, ladders and dead players are excused; `/tp` and dimension changes are ignored.

What it cannot do: it does not see packets, so no reach, killaura, autoclicker, scaffold, nuker or no-fall. **Clients**: a vanilla server neither logs the client brand nor
can it be read in online mode, so there is no client list. Texture packs a player installed themselves are invisible too; only the pack the server hands out is checked.
Player commands are not written to the log by vanilla, so command spam is only seen on servers that log them (e.g. Paper; not verified here). A hover is only noticed
if the client reports "not on ground" and there is at least one block of air below. A player who dies and respawns far away can show up as an "Großer Sprung" (info only).
