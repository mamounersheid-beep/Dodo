-- R2.2-D schema prerequisite only — BonusLedgerType.REDEEM_RESTORE
-- Paper: docs/10.13-returns-clawback.md §3b.5 (Option C)
-- No table/column/index/relation changes

ALTER TYPE "BonusLedgerType" ADD VALUE 'REDEEM_RESTORE';
