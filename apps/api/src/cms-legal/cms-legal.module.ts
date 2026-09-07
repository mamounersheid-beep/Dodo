import { Module } from "@nestjs/common";
import { CmsLegalController } from "./cms-legal.controller";
import { CmsLegalService } from "./cms-legal.service";

@Module({ controllers: [CmsLegalController], providers: [CmsLegalService] })
export class CmsLegalModule {}
