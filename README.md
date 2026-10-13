# samuelkurt Umbrel community app store

One app so far: **playit.gg Tunnel** (`samuelkurt-playit`). It runs the official
playit.gg agent so friends can join your Minecraft server without Tailscale or
port forwarding (works behind CGNAT).

## 1. Publish this store

1. Create a **public** GitHub repo, e.g. `samuelkurt/umbrel-community-store`
   (if you pick another name or branch, update the `icon:` URL in
   `samuelkurt-playit/umbrel-app.yml`).
2. Push the contents of this folder to it.
3. In umbrelOS: App Store, three-dots menu, Community App Stores, paste the repo URL, Add.
4. Open the store from the same menu and install **playit.gg Tunnel**.

## 2. Give the agent its secret key (never commit this)

1. At playit.gg create an agent and copy its secret key.
2. On the Umbrel (SSH), save it into the app's data folder:

```bash
sudo mkdir -p ~/umbrel/app-data/samuelkurt-playit/data
echo 'PASTE_SECRET_KEY_HERE' | sudo tee ~/umbrel/app-data/samuelkurt-playit/data/secret.key >/dev/null
sudo chmod 600 ~/umbrel/app-data/samuelkurt-playit/data/secret.key
```

If `~/umbrel/app-data` does not exist on your umbrelOS version, find the app's folder:

```bash
sudo find / -maxdepth 5 -type d -name samuelkurt-playit 2>/dev/null
```

3. Restart the app from its tile (three dots, Restart).

Until the file exists the agent only prints a "no secret key yet" message every
30 seconds; it does not crash-loop.

## 3. Create the tunnel

In the playit.gg dashboard add a **Minecraft Java** tunnel. The agent uses host
networking, so the local address is `127.0.0.1` plus the port your Crafty server
publishes on the host. Find it with:

```bash
docker ps --format 'table {{.Names}}\t{{.Ports}}' | grep -i crafty
```

If the Minecraft port is not published on the host, use the Crafty container's IP
instead (`docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' <container>`).

## Notes

- The tile opens a static info page. It shows that the app is up, not that the
  agent is connected; check the app logs or the playit.gg dashboard for that.
- The agent image is `ghcr.io/playit-cloud/playit-agent:latest`. If upstream
  changes how it starts, pin a specific tag in `docker-compose.yml`.
- Security: whitelist on, `online-mode=true`, never tunnel Crafty's web panel (8443).
# umbrel-community-store
# umbrel-community-store
# umbrel-community-store
# umbrel-community-store
# umbrel-community-store
