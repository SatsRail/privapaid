# wiki-staging

Source files for the [GitHub wiki](https://github.com/SatsRail/privapaid/wiki), kept in the main repo so they get reviewed in PRs alongside code changes that motivate them.

The wiki itself is a separate git repository at `https://github.com/SatsRail/privapaid.wiki.git`.

## First-time setup

Before you can clone the wiki repo, the wiki needs to exist:

1. Repo Settings → **Features** → check **Wikis**
2. Click the **Wiki** tab → **Create the first page** (any title and content; it'll be replaced)

Once one page exists, the wiki repo is clonable.

## Sync wiki-staging → live wiki

```bash
# One-time clone alongside this repo
cd ..
git clone https://github.com/SatsRail/privapaid.wiki.git privapaid.wiki

# Each time you update wiki content
cp privapaid/wiki-staging/*.md privapaid.wiki/
cd privapaid.wiki
git add . && git commit -m "Sync from wiki-staging" && git push
```

After the first push, the wiki is live at https://github.com/SatsRail/privapaid/wiki.

## File-naming conventions

GitHub wikis derive page titles from filenames:

- `Home.md` → wiki homepage
- `_Sidebar.md` → left sidebar nav (shown on every page)
- `_Footer.md` → footer (shown on every page)
- `Hyphen-Names.md` → page titled "Hyphen Names" at `/wiki/Hyphen-Names`

Wiki-link syntax `[[Page Name]]` resolves to `/wiki/Page-Name`.

## Pages

| File | Wiki URL | Audience |
|---|---|---|
| `Home.md` | `/wiki/Home` | Landing page, table of contents |
| `_Sidebar.md` | (sidebar on every page) | Navigation |
| `Deploy-on-Railway.md` | `/wiki/Deploy-on-Railway` | Operators using Railway |
| `Deploy-on-EC2.md` | `/wiki/Deploy-on-EC2` | Operators on AWS EC2 |
| `Operator-Playbook.md` | `/wiki/Operator-Playbook` | All operators (env vars, key backup, monitoring) |
| `Content-Import.md` | `/wiki/Content-Import` | Operators populating their instance from JSON |
| `Orphan-Cleanup.md` | `/wiki/Orphan-Cleanup` | Operators scheduling the cleanup cron |
| `Stuck-Migrations.md` | `/wiki/Stuck-Migrations` | Operators recovering from a failed migration |
| `Missing-CONTENT_KEK.md` | `/wiki/Missing-CONTENT_KEK` | Operators who didn't set or lost CONTENT_KEK |
| `Healthcheck-Failures.md` | `/wiki/Healthcheck-Failures` | Operators diagnosing `/api/health` failures |

## What stays in this repo vs the wiki

| Lives in `docs/` (code-coupled, versioned with the code) | Lives in the wiki (operator-facing, evolves on its own) |
|---|---|
| Encryption architecture (`docs/ENCRYPTION.md`) | Deployment walkthroughs |
| Sensitive design notes | Troubleshooting runbooks |
| API surface reference | Operator playbooks |
| Test design (`tests/integration/decryption-e2e/README.md`) | Backup procedures |

The rule of thumb: if a code change motivates a doc update, it lives in the repo so the doc moves in the same PR. If a doc update can ship without touching code, the wiki is fine.
