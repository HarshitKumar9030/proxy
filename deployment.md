# Deployment Guide (VM) - Proxy Console

This guide walks through deploying the Express proxy app (`vm-proxy-server`) on a fresh Linux VM (Ubuntu/Debian flavor). Adjust paths and commands as needed for your environment.

---
## 1. Architecture Overview
- Node.js app (Express) listening on `PORT=2456` bound to `HOST=127.0.0.1` (only local interface)
- Reverse proxy: **Nginx** terminates TLS for `proxy.shriju.me`
- Persistent request history backed by `better-sqlite3` (SQLite). Falls back automatically to a JSON file if native module fails.
- Service managed by **systemd**
- Health endpoint: `GET /healthz`
- Dashboard UI at `/`
- Proxy endpoint: `/proxy?target=<absolute_url>`
- History API: `/api/history`

---
## 2. Prerequisites
1. A VM (e.g., Ubuntu 22.04 LTS) with public IPv4.
2. DNS A record pointing `proxy.shriju.me` → your VM IP.
3. SSH access with a sudo-capable user.
4. Open inbound ports: 22 (SSH), 80 (HTTP), 443 (HTTPS). Port 2456 not exposed (internal only).

---
## 3. System Preparation
```bash
# Update system
sudo apt update && sudo apt -y upgrade

# Install base tooling
sudo apt install -y build-essential curl git ufw nginx

# (Optional) Hardening extras
sudo apt install -y fail2ban
```

Enable firewall:
```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status
```

---
## 4. Install Node.js (LTS) via nvm (recommended)
```bash
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
source ~/.nvm/nvm.sh
nvm install --lts
node -v
npm -v
```
(Alternatively use distro packages or NodeSource, but nvm eases upgrades.)

---
## 5. Create Service User & Directory
```bash
sudo useradd -r -m -d /opt/vm-proxy -s /usr/sbin/nologin vmproxy
sudo mkdir -p /opt/vm-proxy
sudo chown vmproxy:vmproxy /opt/vm-proxy
```

---
## 6. Deploy Application Code
Option A: Git (if repository hosted)
```bash
sudo -u vmproxy git clone <YOUR_REPO_URL> /opt/vm-proxy
```
Option B: Upload (scp / rsync) your local project into `/opt/vm-proxy`.

Inside the directory install production dependencies:
```bash
cd /opt/vm-proxy
# If using npm
sudo -u vmproxy npm install --omit=dev
# Or if using pnpm (installed globally)
# sudo npm i -g pnpm
# sudo -u vmproxy pnpm install --prod
```

### Native Dependency (better-sqlite3)
`better-sqlite3` compiles a native module. If it fails to build (e.g., missing build tools), the app will fall back to in-memory/JSON history automatically, but **you lose durable relational queries**.

Ensure build prerequisites were installed (`build-essential`). If you need to force rebuild later:
```bash
sudo -u vmproxy npm rebuild better-sqlite3
```

---
## 7. Directory Structure (Key Files)
```
/opt/vm-proxy
  ├─ src/server.js
  ├─ src/historyStore.js
  ├─ package.json
  ├─ proxy.db            (created at runtime if SQLite backend works)
  ├─ history.json        (only if fallback memory store persists)
  ├─ views/index.ejs
  └─ public/
```

Backup targets: `proxy.db` OR `history.json`.

---
## 8. Environment Configuration
Variables used:
- `PORT=2456` (internal listening port)
- `HOST=127.0.0.1` (bind only to loopback)
- `NODE_ENV=production`

You can optionally place them in an override file for systemd (`/etc/systemd/system/vm-proxy.service.d/override.conf`) or directly inline in the unit file.

---
## 9. Systemd Service
Create the unit file:
```bash
sudo tee /etc/systemd/system/vm-proxy.service > /dev/null <<'EOF'
[Unit]
Description=VM Proxy (Express forward proxy UI)
After=network.target
Wants=network-online.target

[Service]
Type=simple
User=vmproxy
Group=vmproxy
WorkingDirectory=/opt/vm-proxy
Environment=PORT=2456
Environment=HOST=127.0.0.1
Environment=NODE_ENV=production
ExecStart=/usr/bin/env node src/server.js
Restart=on-failure
RestartSec=3
# Hardening
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=true
PrivateTmp=true
AmbientCapabilities=

[Install]
WantedBy=multi-user.target
EOF
```
Reload & start:
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now vm-proxy
sudo systemctl status vm-proxy --no-pager
```

Check logs:
```bash
journalctl -u vm-proxy -f
```

Test health:
```bash
curl -s http://127.0.0.1:2456/healthz
```

---
## 10. Nginx Reverse Proxy
Create site file:
```bash
sudo tee /etc/nginx/sites-available/proxy.shriju.me > /dev/null <<'EOF'
server {
    listen 80;
    server_name proxy.shriju.me;

    # Security headers
    add_header X-Frame-Options DENY;
    add_header X-Content-Type-Options nosniff;
    add_header Referrer-Policy no-referrer-when-downgrade;
    add_header X-XSS-Protection "1; mode=block";

    # Proxy settings
    location / {
        proxy_pass http://127.0.0.1:2456/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 90;
    }

    location /healthz { proxy_pass http://127.0.0.1:2456/healthz; }

    # Optional: deny access to DB / internal files if accidentally exposed
    location ~* \.(db|sqlite|sqlite3|json)$ { deny all; }
}
EOF
```
Enable & test:
```bash
sudo ln -s /etc/nginx/sites-available/proxy.shriju.me /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```
Browse: `http://proxy.shriju.me`

---
## 11. TLS (Let's Encrypt / Certbot)
```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d proxy.shriju.me --agree-tos -m you@example.com --no-eff-email
```
Renewal simulation:
```bash
sudo certbot renew --dry-run
```
Certbot modifies the nginx file to add `listen 443 ssl;` blocks automatically.

---
## 12. Log Management
- Access logs: `journalctl -u vm-proxy`
- Nginx logs: `/var/log/nginx/access.log`, `/var/log/nginx/error.log`
- Rotate (logrotate configured by default for nginx)

Optional: integrate with external logging (Vector, Loki, ELK) by tailing journald.

---
## 13. Updating the App
```bash
cd /opt/vm-proxy
sudo -u vmproxy git pull            # or replace files via deploy pipeline
sudo -u vmproxy npm install --omit=dev
sudo systemctl restart vm-proxy
curl -f http://127.0.0.1:2456/healthz && echo OK
```
Rollback: checkout previous commit and restart.

---
## 14. Backups
If using SQLite backend:
```bash
sudo systemctl stop vm-proxy
cp /opt/vm-proxy/proxy.db /var/backups/proxy.db.$(date +%F-%H%M)
sudo systemctl start vm-proxy
```
If on fallback JSON mode: back up `history.json` the same way.

Automate with a cron job:
```bash
0 3 * * * root test -f /opt/vm-proxy/proxy.db && cp /opt/vm-proxy/proxy.db /var/backups/proxy.db.$(date +\%F)
```

---
## 15. Monitoring & Alerts
Minimal curl probe:
```bash
curl -fsS http://127.0.0.1:2456/healthz | grep '"status":"ok"'
```
Add to an external uptime monitor (use HTTPS public URL once TLS is enabled).

Suggested metrics (future):
- Request count per minute
- Error rate (status >= 500)
- Average latency trend

---
## 16. Security Hardening Checklist
| Area | Action |
|------|--------|
| Network | Only 80/443 exposed; app bound to localhost |
| Process | `NoNewPrivileges`, `ProtectSystem`, `PrivateTmp` in systemd |
| TLS | Auto-renew with certbot timer |
| Headers | Basic security headers in nginx |
| DB Exposure | Deny direct access to *.db / *.json via nginx rule |
| Updates | Regular `git pull` + `npm audit` review |

Run basic vulnerability audit:
```bash
cd /opt/vm-proxy
sudo -u vmproxy npm audit --omit=dev
```

---
## 17. Troubleshooting
| Symptom | Fix |
|---------|-----|
| `better-sqlite3` build fails | Ensure `build-essential` installed; run `npm rebuild better-sqlite3` |
| 502 from nginx | Check `systemctl status vm-proxy` and logs; confirm PORT/HOST |
| History empty | Requests not hitting `/proxy`; verify query param `target` |
| Certbot challenge fails | DNS not propagated or port 80 blocked |
| High latency | Check upstream target response times; network path |

---
## 18. Clean Uninstall
```bash
sudo systemctl disable --now vm-proxy
sudo rm /etc/systemd/system/vm-proxy.service
sudo systemctl daemon-reload
sudo rm -rf /opt/vm-proxy
sudo rm /etc/nginx/sites-enabled/proxy.shriju.me /etc/nginx/sites-available/proxy.shriju.me
sudo nginx -t && sudo systemctl reload nginx
sudo certbot delete --cert-name proxy.shriju.me
```

---
## 19. Optional Enhancements
- Add Basic Auth or an auth proxy (e.g., Authelia, OAuth2 Proxy)
- Rate limiting in nginx (`limit_req_zone`)
- Structured logs (JSON) for ingestion
- Prometheus exporter with metrics (custom endpoint)
- Webhook triggers on new host discovered

---
## 20. Quick One-Liner (Install + Run Without Nginx)
(Dev/testing only – not secure for production exposure):
```bash
npm install && PORT=2456 HOST=0.0.0.0 node src/server.js
```
Then browse: `http://SERVER_IP:2456`

---
**Deployment complete.**
