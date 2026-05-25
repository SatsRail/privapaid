# Contributing to PrivaPaid

Thank you for your interest in contributing! This guide covers everything you need to get started.

## Development Setup

### Prerequisites

- Node.js 20+
- Docker & Docker Compose
- Git

### Getting Started

```bash
# Clone the repo
git clone https://github.com/SatsRail/privapaid_app.git
cd privapaid_app

# Install dependencies
npm install

# Start Postgres
docker compose up -d postgres

# Copy environment config
cp .env.example .env

# Run database migrations/seeds (if applicable)
# npm run seed

# Start the dev server
npm run dev
```

The app runs at `http://localhost:3000`.

### Running with Docker

```bash
docker compose up --build
```

## Project Structure

```
src/
  app/           # Next.js App Router pages & API routes
  components/    # Shared UI components
  models/        # Mongoose models
  lib/           # Utilities (encryption, validation, rate limiting, etc.)
  i18n/          # Internationalization (en.json, es.json)
public/          # Static assets
docker/          # Docker configuration files
```

## Coding Standards

- **TypeScript** — all new code must be typed. Avoid `any`.
- **ESLint** — run `npm run lint` before committing. Pre-commit hooks enforce this.
- **Formatting** — consistent style is enforced via ESLint rules.
- **Naming** — components in PascalCase, utilities in camelCase, DB fields in snake_case.
- **Imports** — use `@/` path aliases (e.g., `@/lib/fetcher`, `@/components/ui/Button`).

## Making Changes

1. **Create a branch** from `main`:
   ```bash
   git checkout -b feat/your-feature
   ```

2. **Write your code** following the standards above.

3. **Test locally** — verify the dev server runs without errors:
   ```bash
   npm run dev
   npx tsc --noEmit
   npm run lint
   ```

4. **Commit** using [conventional commits](https://www.conventionalcommits.org/):
   ```
   feat: add customer profile editing
   fix: resolve checkout race condition
   docs: update API reference
   ```

5. **Push and open a PR** against `main`.

## Pull Request Process

- Fill out the PR template completely.
- Ensure the type-checker and linter pass.
- Keep PRs focused — one feature or fix per PR.
- Add screenshots for UI changes.
- Update translations (both `en.json` and `es.json`) if adding user-facing strings.

## Internationalization

All user-facing strings must use the `t()` function from `@/i18n/useLocale`. Add keys to both `src/i18n/en.json` and `src/i18n/es.json`. Use pluralization suffixes (`_zero`, `_one`, `_other`) for countable items.

## API Routes

- API routes live in `src/app/api/`.
- Use Zod schemas from `src/lib/validate.ts` for request validation.
- Admin routes require session authentication.
- Public mutation routes should have rate limiting (see `src/lib/rate-limit.ts`).

## Reporting Issues

- Use the **Bug Report** template for bugs.
- Use the **Feature Request** template for new features.
- Search existing issues before creating a new one.

## License

By contributing, you agree that your contributions will be licensed under the project's existing license.
