import { Injectable } from "@nestjs/common";

@Injectable()
export class ReturnsService {
  skeleton() {
    return { module: "returns", ready: true, commerce: false };
  }
}
