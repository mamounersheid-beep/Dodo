/** Provider create never created an object (4xx-class reject). Do not write FAILED. */
export class ProviderCreateRejectedError extends Error {
  readonly kind = "rejected" as const;
  constructor(message = "Payment provider rejected create") {
    super(message);
    this.name = "ProviderCreateRejectedError";
  }
}

/** Request may have reached the provider; object may exist. Do not write FAILED. */
export class ProviderCreateUnknownError extends Error {
  readonly kind = "unknown" as const;
  constructor(message = "Payment provider create outcome unknown") {
    super(message);
    this.name = "ProviderCreateUnknownError";
  }
}

export function isProviderCreateRejected(e: unknown): e is ProviderCreateRejectedError {
  return e instanceof ProviderCreateRejectedError;
}

export function isProviderCreateUnknown(e: unknown): e is ProviderCreateUnknownError {
  return e instanceof ProviderCreateUnknownError;
}
