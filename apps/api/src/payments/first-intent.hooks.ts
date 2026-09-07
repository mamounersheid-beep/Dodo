export const FIRST_INTENT_TEST_HOOKS = "FIRST_INTENT_TEST_HOOKS";

/** Optional test/local fake adapters. Production omits this token. */
export const FIRST_INTENT_MEMORY = "FIRST_INTENT_MEMORY";

export type FirstIntentTestHooks = {
  beforePersist?: () => Promise<void> | void;
};

/** Mutable test seam — production never provides FIRST_INTENT_TEST_HOOKS. */
export const paymentIntentTestHooks: FirstIntentTestHooks = {};
