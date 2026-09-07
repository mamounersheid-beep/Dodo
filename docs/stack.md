# Stack (locked unless ADR)

| Layer | Choice |
|-------|--------|
| Monorepo | pnpm + Turborepo |
| Language | TypeScript strict |
| API | NestJS (skeleton → Nest in step 9); current: health HTTP |
| ORM | Prisma |
| DB | PostgreSQL |
| Cache/queues | Redis + BullMQ |
| Search | Meilisearch |
| Files | S3-compatible (MinIO local) |
| Web/Admin | Next.js App Router |
| Payments | Stripe + PayPal (+ Apple/Google Pay via Stripe) |

Rejected: Polyrepo for price types; Mongo for invoices; float money; trusting browser for payment success.
