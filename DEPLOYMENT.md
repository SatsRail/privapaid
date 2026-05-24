# Deployment Guide

Production deployment guide for PrivaPaid. For local development, see [README.md](README.md).

## Prerequisites

- A SatsRail merchant account with API keys
- A domain name pointed to your server
- Docker and Docker Compose installed on the server

---

## Option A: EC2 + Docker Compose (Recommended)

The simplest production setup. One small EC2 instance runs everything.

### 1. Launch an EC2 Instance

- **AMI:** Amazon Linux 2023 or Ubuntu 24.04
- **Instance type:** `t3.small` (2 vCPU, 2 GB RAM) — plenty for most deployments
- **Storage:** 20 GB gp3
- **Security group:** Open ports 22 (SSH), 80 (HTTP), 443 (HTTPS)
- **Elastic IP:** Allocate and associate one for stable DNS

**Estimated cost:** ~$15/month

### 2. Install Docker

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

### 3. Deploy the App

```bash
git clone https://github.com/SatsRail/media.git && cd media
cp .env.docker.example .env
```

Edit `.env` with your production values:

```bash
MONGODB_URI=mongodb://admin:YOUR_STRONG_PASSWORD@mongo:27017/media?authSource=admin
MONGO_INITDB_ROOT_USERNAME=admin
MONGO_INITDB_ROOT_PASSWORD=YOUR_STRONG_PASSWORD

NEXTAUTH_URL=https://yourdomain.com
NEXTAUTH_SECRET=$(openssl rand -base64 32)

INSTANCE_NAME=YourBrand
INSTANCE_DOMAIN=yourdomain.com
SATSRAIL_API_URL=https://satsrail.com/api/v1

SK_ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
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

### 4. Reverse Proxy with Nginx + SSL

Install Nginx and Certbot:

```bash
sudo dnf install -y nginx
sudo systemctl enable --now nginx

# Install Certbot
sudo dnf install -y certbot python3-certbot-nginx
```

Create `/etc/nginx/conf.d/media.conf`:

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

---

## Option B: Elastic Beanstalk Docker

For teams already on AWS Elastic Beanstalk.

### 1. Create `Dockerrun.aws.json`

```json
{
  "AWSEBDockerrunVersion": "1",
  "Image": {
    "Name": "ghcr.io/satsrail/media:latest",
    "Update": "true"
  },
  "Ports": [
    { "ContainerPort": 3000, "HostPort": 3000 }
  ]
}
```

### 2. Create EB Environment

```bash
eb init media-app --platform "Docker" --region us-east-1
eb create media-prod --single --instance-type t3.small
```

### 3. Configure Environment Variables

Set all `.env` variables via EB environment properties:

```bash
eb setenv MONGODB_URI="mongodb+srv://..." NEXTAUTH_URL="https://..." ...
```

### 4. MongoDB

Use **MongoDB Atlas** (not the Docker Compose mongo service):
- Free tier (M0) handles small deployments
- Shared clusters start at $9/month for production
- EB doesn't support persistent volumes for local MongoDB

---

## Option C: Railway

The fastest path to production. Railway handles Docker builds, MongoDB, and SSL automatically.

### 1. Deploy

Click the button in [README.md](README.md) or visit [railway.com/deploy](https://railway.com/deploy/j2B0mN?referralCode=6xvEI7).

Railway creates two services:
- **App** — built from the Dockerfile in this repo
- **MongoDB** — Railway plugin, automatically connected via `MONGODB_URI`

### 2. Set Environment Variables

Railway prompts for these during deploy:

| Variable | Value |
|----------|-------|
| `ADMIN_EMAIL` | Your email |
| `ADMIN_NAME` | Your name |
| `ADMIN_PASSWORD` | Strong password |
| `NEXTAUTH_URL` | Your Railway URL (e.g. `https://stream-production-xxxx.up.railway.app`) |
| `SATSRAIL_API_URL` | `https://satsrail.com/api/v1` |

Secrets (`NEXTAUTH_SECRET`, `SK_ENCRYPTION_KEY`) are auto-generated on first boot.

### 3. Seed the Database

In Railway's shell (Service > Shell tab):

```bash
sh scripts/docker-seed.sh
```

### 4. Custom Domain (Optional)

Settings > Networking > Custom Domain. Railway handles SSL automatically.

**Estimated cost:** Hobby plan $5/month + usage (~$5-10/month for small instances).

---

## MongoDB: Atlas vs Local

| | Atlas (Cloud) | Local (Docker Compose) |
|---|---|---|
| **Setup** | Create cluster on atlas.mongodb.com | Included in docker-compose.yml |
| **Backups** | Automatic, point-in-time | Manual (see below) |
| **Scaling** | Click to scale | Limited to server resources |
| **Cost** | Free tier available, $9+/month for prod | Free (uses server disk) |
| **Best for** | Production, Elastic Beanstalk | Development, small self-hosted |

To use Atlas: replace `MONGODB_URI` in `.env` with your Atlas connection string and remove the `mongo` service from `docker-compose.yml`.

---

## Backups

### MongoDB (Docker Compose)

Create a daily backup cron job:

```bash
# /etc/cron.daily/media-backup
#!/bin/bash
BACKUP_DIR=/home/ec2-user/backups/$(date +%Y%m%d)
mkdir -p "$BACKUP_DIR"
docker compose -f /home/ec2-user/media/docker-compose.yml exec -T mongo \
  mongodump --authenticationDatabase admin \
  -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" \
  --archive > "$BACKUP_DIR/media.archive"

# Keep last 30 days
find /home/ec2-user/backups -maxdepth 1 -mtime +30 -exec rm -rf {} +
```

```bash
sudo chmod +x /etc/cron.daily/media-backup
```

### Restore

```bash
docker compose exec -T mongo mongorestore --authenticationDatabase admin \
  -u admin -p YOUR_PASSWORD --archive < backups/20260315/media.archive
```

---

## Upgrading

Pull the latest image and restart:

```bash
cd media
git pull
docker compose build
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

Or if using the published image:

```bash
docker pull ghcr.io/satsrail/media:latest
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

---

## Monitoring

### Health Check

```bash
curl https://yourdomain.com/api/health
# { "status": "ok", "mongo": "connected", "satsrail": "reachable" }
```

### Logs

```bash
docker compose logs -f app     # App logs
docker compose logs -f mongo   # MongoDB logs
```

### Docker Status

```bash
docker compose ps              # Container status + health
docker stats                   # CPU/memory usage
```

---

## Rotating `SK_ENCRYPTION_KEY`

`SK_ENCRYPTION_KEY` is the envelope key that protects every
`Settings.satsrail_api_key_encrypted` row — i.e. your merchant's live
`sk_live_` SatsRail API key at rest. Rotate it when you suspect leakage
(stolen container, compromised env file, departed contractor with access),
on a regular cadence (annually is a reasonable baseline), or after migrating
to a different secret store.

The rotation is a single offline operation. **Schedule a brief maintenance
window** — the app must be stopped or in a read-only state while it runs,
because the script atomically swaps the ciphertext on every Settings row
and a request mid-rotation could read a row encrypted with one key while
the runtime is configured for the other.

### Procedure

1. **Generate a new key.** Use the same format the entrypoint uses (32
   random bytes, hex-encoded):

   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

   Save it somewhere safe NOW — losing this between steps 2 and 5 means
   losing access to every encrypted merchant key.

2. **Back up MongoDB.** A `mongodump` snapshot makes any failed rotation
   trivially reversible.

3. **Stop the app** (or take it offline behind a maintenance page). This
   removes the request-mid-rotation race window.

4. **Dry-run the rotation** to confirm it would succeed before touching
   anything:

   ```bash
   OLD_SK_ENCRYPTION_KEY=<current key> \
   NEW_SK_ENCRYPTION_KEY=<key from step 1> \
   MONGODB_URI=mongodb://... \
   npx tsx scripts/rotate-encryption-key.ts --dry-run
   ```

   Exit code 0 = every row decrypts cleanly with the old key. Exit code 2
   means at least one row failed — investigate before proceeding (likely
   a previously-interrupted rotation, hand-edited ciphertext, or wrong
   `OLD_SK_ENCRYPTION_KEY`).

5. **Apply the rotation:**

   ```bash
   OLD_SK_ENCRYPTION_KEY=<current key> \
   NEW_SK_ENCRYPTION_KEY=<key from step 1> \
   MONGODB_URI=mongodb://... \
   npx tsx scripts/rotate-encryption-key.ts
   ```

   The script reports each row as it rewraps. Idempotent — re-running on
   already-rewrapped rows will fail the decrypt step and exit 2, which is
   the safe behavior (it won't double-encrypt).

6. **Update runtime env.** Set `SK_ENCRYPTION_KEY=<key from step 1>` in
   your secret store / `.env`. If you use the auto-generated file at
   `/app/data/.generated-env`, also update the value there so subsequent
   restarts don't fall back to the old key.

7. **Restart the app.** The startup probe at
   [src/lib/startup-checks.ts](src/lib/startup-checks.ts) will trial-decrypt
   the stored ciphertext on boot. In production, a key mismatch causes
   `process.exit(1)` — a clean signal that the rotation didn't take.

8. **Verify on a real request.** Hit any admin endpoint that touches
   SatsRail (e.g., open the products page in the admin UI). If the
   merchant key was rewrapped correctly, the SatsRail call succeeds.

9. **Scrub the old key.** Remove `OLD_SK_ENCRYPTION_KEY` from your secret
   store and shell history. You no longer need it.

### Recovery if step 5 fails partway

The script processes rows one at a time, so a crash mid-run leaves a mix
of old-wrapped and new-wrapped rows. Two recovery paths:

- **Forward:** re-run the script with the same OLD/NEW pair. Already-new
  rows fail the OLD-key decrypt and are reported as failures; the rest
  finish. Exit code 2 is expected; the summary line tells you how many
  were already done.
- **Rollback:** swap OLD and NEW in env and re-run. The newly-wrapped
  rows decrypt with NEW (now treated as the "old"), and the un-touched
  rows fail. Combined with the MongoDB backup from step 2, this is a
  belt-and-braces option.

---

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| App won't start | Missing env vars | Check `docker compose logs app` for errors |
| MongoDB connection refused | Mongo not ready | Wait for health check, check `docker compose logs mongo` |
| Health check returns 503 | MongoDB or SatsRail down | Check `MONGODB_URI` and `SATSRAIL_API_URL` |
| SSL not working | Certbot didn't run | Run `sudo certbot --nginx -d yourdomain.com` |
| Payments not working | Wrong API keys | Verify `SK_ENCRYPTION_KEY` and SatsRail merchant config |
| Seed script fails | Missing admin env vars | Set `ADMIN_EMAIL`, `ADMIN_NAME`, `ADMIN_PASSWORD` in `.env` |
