# PrivaPaid Stream Wiki

Operator-facing guides for deploying and running PrivaPaid in production.

For architecture, encryption design, and code-coupled documentation, see [`docs/`](https://github.com/SatsRail/privapaid/tree/main/docs) in the main repo. Those files are versioned with the code so they can't drift out of sync.

## Deployment

- [[Deploy on Railway]] — one-click template, the fastest path to production
- [[Deploy on EC2]] — `t3.small` + Docker Compose, the simplest VM setup
- [[Deploy on Elastic Beanstalk]] — for teams already on AWS EB
- [[Postgres Managed vs Local]] — provider trade-offs

## Operations

- [[Operator Playbook]] — every env var, what protects what, how to back up the keys
- [[Content Import]] — JSON import format for whole-site and per-channel
- [[Orphan Cleanup]] — recover storage from abandoned uploads
- [[Backups and Restore]] — Postgres dumps, KEK backups, restore procedure
- [[Upgrading]] — version bumps without breaking encryption

## Troubleshooting

- [[Stuck Migrations]] — when `_prisma_migrations` has an unresolved row
- [[Missing CONTENT_KEK]] — symptoms, fix, recovery
- [[Healthcheck Failures]] — what `/api/health` reports and how to read it
- [[Key Rotation Errors]] — when rotation gets stuck mid-stream

## Reference

- [Architecture — docs/ENCRYPTION.md](https://github.com/SatsRail/privapaid/blob/main/docs/ENCRYPTION.md) — canonical encryption design
- [Changelog](https://github.com/SatsRail/privapaid/blob/main/CHANGELOG.md)
- [License — FSL-1.1-ALv2](https://github.com/SatsRail/privapaid/blob/main/LICENSE)
