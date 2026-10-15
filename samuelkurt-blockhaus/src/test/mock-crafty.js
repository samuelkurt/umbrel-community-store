'use strict';
// Stand-in for the Crafty Controller API v2, shaped after its OpenAPI spec. For tests and screenshots only.
const http = require('node:http');

function createMockCrafty({ serverPath = '/crafty/servers/uuid-1', token = 'tok123', user = 'admin', pass = 'secret' } = {}) {
  const st = {
    running: false,
    pingOk: false,
    crashed: false,
    players: [],
    log: ['[10:00:00] [Server thread/INFO]: Preparing level "world"'],
    stdin: [],
    actions: [],
    logins: 0,
    onStdin: null,
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.method === 'POST' && url.pathname === '/api/v2/auth/login') {
        const b = JSON.parse(body || '{}');
        st.logins++;
        if (b.username === user && b.password === pass) return json(200, { status: 'ok', data: { token: 'jwt-' + st.logins, user_id: '1' } });
        return json(400, { status: 'error', error: 'INCORRECT_CREDENTIALS' });
      }
      const auth = req.headers.authorization || '';
      const okTok = auth === 'Bearer ' + token || /^Bearer jwt-/.test(auth);
      if (!okTok) return json(403, { status: 'error', error: 'NOT_AUTHORIZED' });
      if (req.method === 'GET' && url.pathname === '/api/v2/servers') {
        return json(200, { status: 'ok', data: [{
          server_id: 'uuid-1', server_name: 'Samuels Welt', path: serverPath, executable: 'vanilla.jar',
          execution_command: 'java -Xms1000M -Xmx6000M -jar vanilla.jar nogui', server_port: 25565, type: 'minecraft-java',
        }] });
      }
      let m = /^\/api\/v2\/servers\/([^/]+)\/(.+)$/.exec(url.pathname);
      if (!m) return json(404, { status: 'error', error: 'NOT_FOUND' });
      const [, , rest] = m;
      if (req.method === 'GET' && rest === 'stats') {
        return json(200, { status: 'ok', data: {}, running: st.running, crashed: st.crashed, cpu: st.running ? 12.5 : 0,
          mem: st.running ? '2.4GB' : '0 B', mem_percent: st.running ? 31 : 0, world_name: 'world', world_size: '412.3 MB',
          server_port: 25565, int_ping_results: st.pingOk, online: st.players.length, max: 20,
          players: JSON.stringify(st.players).replace(/"/g, "'"), desc: 'Hallo Welt', icon: '', version: '1.21.4',
          updating: false, waiting_start: false, first_run: false });
      }
      if (req.method === 'GET' && rest === 'logs') return json(200, { status: 'ok', data: st.log });
      if (req.method === 'POST' && rest === 'stdin') { st.stdin.push(body); if (st.onStdin) st.onStdin(body); return json(200, { status: 'ok' }); }
      if (req.method === 'POST' && (m = /^action\/(\w+)$/.exec(rest))) {
        st.actions.push(m[1]);
        if (m[1] === 'start_server') { st.running = true; st.pingOk = false; }
        if (m[1] === 'stop_server' || m[1] === 'kill_server') { st.running = false; st.pingOk = false; st.players = []; }
        return json(200, { status: 'ok' });
      }
      return json(404, { status: 'error', error: 'NOT_FOUND' });
    });
  });
  return { server, state: st, token, user, pass };
}

module.exports = { createMockCrafty };
