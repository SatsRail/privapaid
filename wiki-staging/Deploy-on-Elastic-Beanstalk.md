# Deploy on Elastic Beanstalk

For teams already on AWS Elastic Beanstalk. If you're starting from scratch and not committed to EB, [[Deploy on EC2]] is simpler and cheaper.

## 1. Create `Dockerrun.aws.json`

```json
{
  "AWSEBDockerrunVersion": "1",
  "Image": {
    "Name": "ghcr.io/satsrail/privapaid:latest",
    "Update": "true"
  },
  "Ports": [
    { "ContainerPort": 3000, "HostPort": 3000 }
  ]
}
```

## 2. Create the EB environment

```bash
eb init privapaid --platform "Docker" --region us-east-1
eb create privapaid-prod --single --instance-type t3.small
```

## 3. Configure environment variables

Set everything from your `.env` via EB environment properties:

```bash
eb setenv \
  DATABASE_URL="postgresql://..." \
  NEXTAUTH_URL="https://yourdomain.com" \
  NEXTAUTH_SECRET="$(openssl rand -base64 32)" \
  SK_ENCRYPTION_KEY="$(openssl rand -hex 32)" \
  CONTENT_KEK="$(openssl rand -base64 32)" \
  SATSRAIL_API_URL="https://satsrail.com/api/v1" \
  SATSRAIL_WEBHOOK_SECRET="your-webhook-secret"
```

**Back up `SK_ENCRYPTION_KEY` and `CONTENT_KEK` to your password manager before running these.** EB stores env vars but operators routinely lose access; the only authoritative copy needs to be off-platform. See [[Operator Playbook]] for the full backup procedure.

## 4. Postgres

Use a managed Postgres — not the Docker Compose `postgres` service:

- **RDS** or **Aurora Serverless v2** are the obvious EB pairings
- EB doesn't support persistent volumes for a local Postgres container
- The Docker entrypoint runs `prisma migrate deploy` on boot; the managed DB just needs to be reachable via `DATABASE_URL`

See [[Postgres Managed vs Local]] for trade-offs.

## 5. Custom domain + SSL

EB's load balancer terminates SSL. Configure via the EB console: **Configuration → Load balancer → Add listener (HTTPS, ACM cert)**.

Update `NEXTAUTH_URL` to the custom domain after the cert is issued.

## Ephemeral storage warning

EB single-container Docker uses ephemeral disk by default. The PrivaPaid entrypoint's `detect_ephemeral_fs` check will **refuse to auto-generate** missing secrets on ephemeral storage. Set `NEXTAUTH_SECRET`, `SK_ENCRYPTION_KEY`, and `CONTENT_KEK` explicitly via `eb setenv` before the container boots.

## See also

- [[Operator Playbook]] — env var reference and key backup procedures
- [[Postgres Managed vs Local]] — which managed Postgres provider fits
- [[Backups and Restore]] — RDS automated backups + KEK backup off-platform
