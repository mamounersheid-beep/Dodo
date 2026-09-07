/**
 * Shared no-op EmailIntegrationPort for Nest test modules.
 * Keep in sync with EmailIntegrationPort methods.
 */
import type { EmailIntegrationPort } from "./email-integration.port";

const noop = async (): Promise<void> => undefined;

export function createEmailIntegrationStub(
  overrides: Partial<EmailIntegrationPort> = {},
): EmailIntegrationPort {
  return {
    enqueueAuthEmail: noop,
    enqueueOrderConfirmation: noop,
    enqueueOrderConfirmationResend: noop,
    enqueueOrderCancelled: noop,
    enqueueShipmentEmail: noop,
    enqueueInvoiceEmail: noop,
    enqueueRefundEmail: noop,
    enqueueDeliveryEmail: noop,
    enqueueReturnRequestEmail: noop,
    ...overrides,
  };
}
