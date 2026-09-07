# Dodo monorepo

German e-commerce platform — build path steps 1–7 live in `../docs/`. This folder is **step 8**: governed empty commerce (no checkout yet).

## Quick start

```bash
cd "my Projekt/dodo"
cp .env.example .env
docker compose up -d
pnpm install
pnpm db:generate
pnpm --filter @dodo/database exec prisma migrate dev --name init
pnpm db:seed
pnpm dev
```

- Web: http://localhost:3000  
- Admin: http://localhost:3002  
- API health: http://localhost:3001/v1/health  

Owner seed: `owner@example.com` — password hash placeholder; replace on first real auth (step 10.1).

## What is intentionally missing

Checkout, Stripe live calls, Nest modules — **steps 9–10**.
