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

### Anticheat: Schwimmen ist kein Fliegen (0.8.2)

Wer im Wasser nach oben schwimmt, ist nicht am Boden und steigt, genau wie ein Cheater. Früher half nur die Luftprüfung beim Urteil (Füße und Kopf in Luft). Sie scheiterte am letzten Schritt: Der Aufstieg endet mit einem Sprung aus dem Wasser, dort ist kurz Luft, und genau dann wurde geprüft. Jetzt wird bei jeder Abfrage eines Spielers, der nicht am Boden steht, sofort geprüft, ob um ihn Luft ist (`execute … if block ~ ~ ~ #minecraft:air if block ~ ~1 ~ #minecraft:air`, eine Zeile mehr im Log pro Runde). Für ein „Schweben“ müssen alle Proben in der Messreihe Luft sein, für ein „Steigen“ die letzten drei; und nach einer Probe im Wasser, auf einer Leiter oder im Spinnennetz wird 8 s lang niemand beurteilt. Der Test bildet das Hochschwimmen mit Sprung nach, der alte Code meldet es, der neue nicht. Am echten 26.3-Server werden ein Schwebe-Cheat und ein Steige-Cheat weiter gemeldet, ein Spieler, der in einem 29 Blöcke tiefen Becken nach oben schwimmt, nicht. Nicht geprüft: Schwimmen mit echtem Minecraft-Client (nur Bot), Lava und Honigblöcke (Lava zählt wie Wasser als „nicht Luft“).

### Texturpakete bei Portweiterleitung (0.8.1)

Minecraft lädt das Paket per HTTP, aber auf dem Minecraft-Port (25565) antwortet Java nur Minecraft. Blockhaus liefert die Pakete deshalb auf einem eigenen Port aus (`PACK_PORT`, Standard 25700; Solo auf Umbrel 25701). Bei Portweiterleitung im Router brauchst du zwei Weiterleitungen: TCP 25565 (Minecraft) und TCP 25700 (Pakete). Trägst du unter Einstellungen als öffentliche Adresse die Minecraft-Adresse ein (Port 25565, der Port des Servers oder gar keiner), baut Blockhaus die Download-Adresse mit dem Pack-Port derselben Adresse. Andere Ports (playit-Tunnel auf den Pack-Port) und eine von Hand eingetragene „Download-Adresse“ bleiben unverändert. Leitest du am Router 25565 direkt auf den Pack-Port um (Blockhaus reicht Minecraft dann weiter), trage die Adresse bei „Download-Adresse“ von Hand ein. „Von außen testen“ sagt bei einem Fehler, ob der Pack-Server auf dem Rechner selbst antwortet (dann fehlen Weiterleitung oder Firewall) oder nicht. Nach dem Update das Paket einmal erneut veröffentlichen, damit die neue Adresse in die server.properties kommt. Reproduziert und geprüft mit einem echten Server und dem Pack-Server von Blockhaus; getestet ist der Download mit HTTP, nicht mit einem echten Minecraft-Client.

### Spielregeln, Nether, End (0.8.0)

Page **Spielregeln** (Minecraft 26 and newer, both app variants): all game rules of the world with German names (`keep_inventory`, `pvp`, `players_sleeping_percentage`, …), as switches and number fields. They are read from `<world>/data/minecraft/game_rules.dat`, which holds every rule with its type, so no query per rule is needed and the page works with the server stopped. Running server: the change goes through `/gamerule` and the world is saved afterwards, so other pages read the new value; stopped server: the file is rewritten (everything else in it stays, a `.blockhaus.bak` is kept) and the value applies at the next start. Rules Blockhaus does not know show up under "Weitere" with their raw name. Older versions keep their rules in `level.dat` in another format; for those, use `/gamerule` in the console.

**Nether:** Minecraft 26 removed `allow-nether` from `server.properties`; the Nether is now the rule `allow_entering_nether_using_portals`. The switch "Nether" in Optionen and the one on the new page set that rule and apply on the spot (no "Speichern"). Older versions keep using `allow-nether`.

**End:** vanilla has no switch. "End betretbar" off writes the data pack `<world>/datapacks/blockhaus_noend`: every tick it checks `@a[tag=!end_erlaubt]` in the End and runs `tp` to the overworld world spawn (taken from `level.dat` when switched on) plus an action-bar message. A running server picks the pack up with `/reload`; a stopped one loads it at the next start. Switching on again removes the folder (only if it is Blockhaus' own); a stopped server then logs `Missing data pack file/blockhaus_noend` once at the next start, which is harmless. Exempt a player (for example an admin who wants to look): `/tag <name> add end_erlaubt`. Checked on a real Vanilla 26.3 server (without the pack the player stays in the End, with it he lands at the spawn; the tag exempts; switching on/off while running and while stopped). Back to the own respawn point (0.8.4): the pack reads the player's `respawn` (bed, anchor, `/spawnpoint`), loads that chunk for a moment (`/forceload`, removed again unless it was already set), checks that the bed or anchor is still there and teleports onto it; otherwise the world spawn from `level.dat`. A respawn point in the End itself is ignored. Verified on 26.3: bed in an unloaded chunk, negative coordinates, bed removed, `/spawnpoint`, no respawn point, chunk kept by `/forceload`. Not tried: respawn anchor, respawn point in the Nether, 1.21.x (reads `SpawnX/Y/Z` there; untested). An older pack is rewritten when the Game rules page is opened.

Pack format: exact from the server jar's `version.json`; when the jar cannot be read (Forge, NeoForge, launchers) a pack that every version from 1.21 on accepts (`pack_format` 48 + `supported_formats` [48, 81] for 1.21 to 1.21.8, `min_format` 48 / `max_format` 9999 for newer ones; loads on 26.3 without a warning). Not tested: Forge/NeoForge/Fabric/Paper servers and 1.21.x (Paper has its own `allow-end: false` in `bukkit.yml`); versions before 1.21 are refused.

### Anticheat (Blockhaus Solo and dedicated server)

It runs inside Blockhaus and only works when Blockhaus starts Minecraft itself, because it needs the live console. In the
Crafty app the page is not shown. Nothing happens by itself: nobody is kicked, banned or warned automatically. Findings are listed on the
page and counted next to the menu entry, and every finding has **manual buttons** (see below). Records are stored in `<data>/anticheat/<server>/` (`config.json`, `flags.json`).

**Items live** (0.7.5, setting "Items live prüfen", on by default): the file check alone only sees what Minecraft has written to the player file (every few minutes and when the player leaves), so a spawner you gave yourself was noticed only after leaving. The live check asks the server for inventory, ender chest and armor of every online player every `itemLiveSec` seconds (default 10, 3–300) and flags impossible items within one round. Creative players and operators are skipped as in the file check. Cost: three `data get entity` lines per player and round in `latest.log` (hidden in the Blockhaus console view); routine rounds never jump ahead of your button clicks. The file check stays as a second source and merges into the same finding.

**Selbsttest** (0.7.2, button on the Anticheat page): pick a player (yourself, online) and Blockhaus runs the whole chain on your real server and shows every step with its time: response time of the server, test items in empty slots (inventory, shulker box with bedrock, helmet slot, off hand, ender chest), detection by live query and by the saved player file, removal with the same code as the button, check that every slot is empty again, the "player moved it" case, clean-up. Occupied slots are never touched. Verified against a real Vanilla 26.3 server and a real Forge 26.3 server (all 16 steps, 0.9 s and 2.8 s). Operators and creative players are not reported in normal operation; the test says so for the player you pick.

Log formats understood (0.7.2): Vanilla/Fabric `[12:16:38] [Server thread/INFO]: …`, Forge/NeoForge `[18Oct2026 20:19:06.771] [Server thread/INFO] [net.minecraft.server.MinecraftServer/]: …`, Paper/Spigot `[12:16:38 INFO]: …`, with or without the `System chat:` prefix, with colour codes. Before 0.7.2 only the first form was recognised, so on Forge, NeoForge and Paper nothing was seen.

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


## Anticheat: Fehlalarme vermeiden (0.8.5)
- **„moved too quickly“ / „moved wrongly“:** Stürze (die Zahlen der Meldung zeigen fast nur nach unten) zählen nicht. Ein Wurf nach oben (Enderdrache, Explosion; ≥ 8 Blöcke zwischen zwei Messungen), eine Portalreise (Dimensionswechsel oder Portalblock an der Position) und `/tp` entschuldigen die Meldungen davor und danach. Erst wenn danach noch genug unerklärte Meldungen übrig sind (mindestens 3 in 60 s, einstellbar), kommt die Meldung, einige Sekunden später als vorher (es wartet auf die nächste Positionsmessung).
- **Fliegen:** Ein Anstieg zählt erst nach 4 Messungen ohne Bodenkontakt, jeder > 1 Block höher; ein einzelner Wurf gibt 12 s Ruhe. Wer weiter steigt, wird danach trotzdem gemeldet.
- **Teleport-Meldung:** Wer stirbt und am eigenen Bett/Anker oder am Welt-Spawn wieder auftaucht, hat nicht „gesprungen“.
- Geprüft auf einem echten 26.3-Server: Portalreise, Tod mit Wiederbelebung 2500 Blöcke entfernt, echte Meldungsreihe wird weiter gemeldet. Nicht nachgestellt: der Enderdrache selbst und ein echter Client (Wurf und Fall nur als Unit-Tests).
