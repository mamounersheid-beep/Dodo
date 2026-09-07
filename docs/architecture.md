# Architecture (repo copy)

See also parent `../docs/ARCHITECTURE.md` if present.

- Monorepo: `apps/web`, `apps/admin`, `apps/api` + `packages/*`
- Single source of pricing/tax/order truth: API + Postgres
- web/admin never compute tax/Bonus as source of truth
- Webhook = payment truth; Decimal money; EU hosting preference
