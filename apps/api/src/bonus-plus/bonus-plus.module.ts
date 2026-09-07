import { Module } from "@nestjs/common";
import { BonusPlusController } from "./bonus-plus.controller";
import { BonusPlusService } from "./bonus-plus.service";

@Module({ controllers: [BonusPlusController], providers: [BonusPlusService] })
export class BonusPlusModule {}
