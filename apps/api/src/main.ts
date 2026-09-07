import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import cookieParser = require("cookie-parser");
import { AppModule } from "./app.module";
import { env } from "./config/env";
import { AllExceptionsFilter } from "./common/filters/all-exceptions.filter";

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { rawBody: true });

  app.setGlobalPrefix("v1");
  app.use(cookieParser());
  app.enableCors({
    origin: env.API_CORS_ORIGINS,
    credentials: true,
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());

  const swagger = new DocumentBuilder()
    .setTitle("Dodo API")
    .setDescription("Step 10.1 — Auth + GDPR (no checkout)")
    .setVersion("0.10.1")
    .addBearerAuth()
    .build();
  SwaggerModule.setup("v1/docs", app, SwaggerModule.createDocument(app, swagger));

  await app.listen(env.API_PORT);
  console.log(`@dodo/api :${env.API_PORT}  docs=/v1/docs  (step 10.1 auth)`);
}

bootstrap().catch((err) => {
  console.error("API failed to start:", err instanceof Error ? err.message : err);
  process.exit(1);
});
