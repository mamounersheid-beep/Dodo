import { Injectable } from "@nestjs/common";

@Injectable()
export class BonusPlusService {
  skeleton() {
    return { module: "bonus-plus", displayName: "Bonus+", ready: true, commerce: false };
  }
}
