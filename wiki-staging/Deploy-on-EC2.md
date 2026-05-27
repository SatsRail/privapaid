# Deploy on EC2 (Docker Compose)

The simplest production setup. One small EC2 instance runs the app, Postgres, and Nginx + Let's Encrypt SSL. Estimated cost: ~$15/month.

## 1. Launch an EC2 instance

- **AMI:** Amazon Linux 2023 or Ubuntu 24.04
- **Instance type:** `t3.small` (2 vCPU, 2 GB RAM)
- **Storage:** 20 GB gp3
- **Security group:** open ports 22 (SSH), 80 (HTTP), 443 (HTTPS)
- **Elastic IP:** allocate and associate one for stable DNS

## 2. Install Docker

```bash
# Amazon Linux 2023
sudo dnf install -y docker
sudo systemctl enable --now docker
sudo usermod -aG docker $USER

# Install Docker Compose plugin
sudo mkdir -p /usr/local/lib/docker/cli-plugins
sudo curl -SL https://github.com/docker/compose/releases/latest/download/docker-compose-linux-x86_64 \
  -o /usr/local/lib/docker/cli-plugins/docker-compose
sudo chmod +x /usr/local/lib/docker/cli-plugins/docker-compose

# Log out and back in for group changes
exit
```

## 3. Deploy the app

```bash
git clone https://github.com/SatsRail/privapaid.git && cd privapaid
cp .env.docker.example .env
```

Edit `.env` with production values:

```bash
DATABASE_URL=postgresql://privapaid:STRONG_PASSWORD@postgres:5432/privapaid?schema=public&connection_limit=20
POSTGRES_USER=privapaid
POSTGRES_PASSWORD=STRONG_PASSWORD
POSTGRES_DB=privapaid

NEXTAUTH_URL=https://yourdomain.com
NEXTAUTH_SECRET=$(openssl rand -base64 32)
SK_ENCRYPTION_KEY=$(openssl rand -hex 32)
CONTENT_KEK=$(openssl rand -base64 32)

INSTANCE_NAME=YourBrand
INSTANCE_DOMAIN=yourdomain.com
SATSRAIL_API_URL=https://satsrail.com/api/v1
SATSRAIL_WEBHOOK_SECRET=your-webhook-secret

ADMIN_EMAIL=you@example.com
ADMIN_NAME=Admin
ADMIN_PASSWORD=a-strong-password
```

Start with production overrides:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
docker compose exec app sh scripts/docker-seed.sh
```

The Docker entrypoint runs `prisma migrate deploy` automatically on boot. On EC2 the `/app/data` directory is on a persistent volume (defined in `docker-compose.yml`), so any auto-generated secrets persist across restarts. EC2 deployments can rely on the entrypoint's auto-generation flow as a fallback if `CONTENT_KEK` etc. aren't set in `.env`, but **explicit is safer** — set them all in `.env` and back up the file.

## 4. Nginx + SSL

```bash
sudo dnf install -y nginx
sudo systemctl enable --now nginx
sudo dnf install -y certbot python3-certbot-nginx
```

`/etc/nginx/conf.d/privapaid.conf`:

```nginx
server {
    server_name yourdomain.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d yourdomain.com
```

Certbot auto-renews via systemd timer.

## See also

- [[Postgres: managed vs local]] — when to switch to RDS / Supabase / Neon
- [[Backups and Restore]] — daily `pg_dump` cron + restore procedure
- [[Upgrading]] — pulling new images without losing data
