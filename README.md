# VM Proxy Server

An Express-based HTTP/HTTPS forward proxy endpoint with a dashboard UI and persistent history storage using SQLite (better-sqlite3). Designed to run on a VM.

## Features
- Proxy endpoint: `/proxy?target=https://example.com/path`
- Persists request history (method, URL, host, status, latency, user-agent, IP, timestamp)
- Dashboard UI at `/` with auto-refreshing table + quick reopen
- History JSON API at `/api/history`
- Lightweight stats (total requests, unique hosts, avg latency)
- Security middleware: helmet, compression, CORS, morgan logging
- Fast embedded DB (SQLite) with automatic table creation

## Quick Start
Default port: `2456` (override with `PORT` environment variable)

Install dependencies and run:

```
npm install
npm run start
```

Navigate to: http://localhost:2456 (after nginx + TLS: https://proxy.shriju.me)

Enter a full URL (including protocol) and it will open proxied in a new tab.

## Systemd (Linux) Example
Create file `/etc/systemd/system/vm-proxy.service`:
```
[Unit]
Description=VM Proxy
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/vm-proxy
ExecStart=/usr/bin/env PORT=2456 HOST=127.0.0.1 NODE_ENV=production node src/server.js
Restart=always
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

Enable & start:
```
systemctl daemon-reload
systemctl enable --now vm-proxy
systemctl status vm-proxy
```

## Nginx Reverse Proxy (proxy.shriju.me)
1. Point DNS A record for `proxy.shriju.me` to your VM public IP.
2. Install nginx (Debian/Ubuntu):
```
apt update
apt install -y nginx
```
3. Create `/etc/nginx/sites-available/proxy.shriju.me`:
```
server {
	listen 80;
	server_name proxy.shriju.me;

	# Basic security headers
	add_header X-Frame-Options DENY;
	add_header X-Content-Type-Options nosniff;
	add_header Referrer-Policy no-referrer-when-downgrade;

	location /healthz { proxy_pass http://127.0.0.1:2456/healthz; }
	location / {
		proxy_pass http://127.0.0.1:2456/;
		proxy_set_header Host $host;
		proxy_set_header X-Real-IP $remote_addr;
		proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
		proxy_set_header X-Forwarded-Proto $scheme;
		proxy_read_timeout 90;
	}
}
```
4. Enable & test:
```
ln -s /etc/nginx/sites-available/proxy.shriju.me /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
```
Browse: `http://proxy.shriju.me` (HTTP only pre-TLS)

## TLS with Certbot (Let's Encrypt)
Install certbot and request certificate:
```
apt install -y certbot python3-certbot-nginx
certbot --nginx -d proxy.shriju.me -m you@example.com --agree-tos --no-eff-email
```
Test renewal:
```
certbot renew --dry-run
```
Certs auto-renew via systemd timer/cron installed by certbot.

## Firewall Tips (UFW)
```
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw enable
```
App listens on localhost only (HOST=127.0.0.1) so port 2456 need not be exposed.

## Notes / Limitations
- This is a simple forwarding mechanism, not a full HTTP CONNECT proxy (no direct browser proxy config). Users must call `/proxy?target=`.
- Only supports absolute URLs via the `target` query parameter.
- Basic error handling; extend as needed for production.

## Future Enhancements
- Add filtering/search in UI
- Add pagination / infinite scroll
- Export history (CSV)
- Simple auth (API key / basic auth)
- Rate limiting

## License
MIT
