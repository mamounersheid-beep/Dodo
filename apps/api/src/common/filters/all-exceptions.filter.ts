import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from "@nestjs/common";
import { Prisma } from "@dodo/database";

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = "INTERNAL_ERROR";
    let message = "Unexpected error";
    let available: number | undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === "string") {
        message = body;
      } else if (typeof body === "object" && body) {
        const obj = body as {
          message?: string | string[];
          error?: string;
          available?: number;
        };
        if ("message" in obj && obj.message !== undefined) {
          const m = obj.message;
          message = Array.isArray(m) ? m.join(", ") : m;
        }
        if (typeof obj.error === "string") code = obj.error;
        if (typeof obj.available === "number") available = obj.available;
      }
      // Generic status defaults only when no specific business error code was provided
      if (status === HttpStatus.UNAUTHORIZED && code === "INTERNAL_ERROR") code = "UNAUTHORIZED";
      if (status === HttpStatus.FORBIDDEN && code === "INTERNAL_ERROR") code = "FORBIDDEN";
      if (status === HttpStatus.NOT_FOUND && code === "INTERNAL_ERROR") code = "NOT_FOUND";
      if (status === HttpStatus.CONFLICT && code === "INTERNAL_ERROR") code = "CONFLICT";
      if (status === HttpStatus.BAD_REQUEST && code === "INTERNAL_ERROR") code = "VALIDATION_ERROR";
      if (status === HttpStatus.TOO_MANY_REQUESTS) code = "RATE_LIMITED";
    } else if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      status = HttpStatus.BAD_REQUEST;
      code = "PRISMA_" + exception.code;
      message = "Database request failed";
    }

    const payload: Record<string, unknown> = {
      code,
      message,
      traceId: ctx.getRequest().headers["x-request-id"] ?? null,
    };
    if (available !== undefined) payload.available = available;

    res.status(status).json(payload);
  }
}
