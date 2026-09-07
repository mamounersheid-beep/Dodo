import { hashPassword, hashToken, newRefreshToken, tokensEqual, verifyPassword } from "./auth/crypto.util";
import { durationToMs } from "./config/duration";

async function main() {
  const pwd = "test-password-ok";
  const hash = await hashPassword(pwd);
  if (!(await verifyPassword(hash, pwd))) throw new Error("argon2 verify failed");
  if (await verifyPassword(hash, "wrong")) throw new Error("argon2 false positive");

  const a = newRefreshToken();
  const b = newRefreshToken();
  if (a === b) throw new Error("refresh tokens not unique");
  const ha = hashToken(a);
  if (!tokensEqual(ha, hashToken(a))) throw new Error("token hash mismatch");
  if (tokensEqual(hashToken(a), hashToken(b))) throw new Error("distinct tokens collided");

  if (durationToMs("15m") !== 900_000) throw new Error("duration 15m");
  if (durationToMs("7d") !== 7 * 86_400_000) throw new Error("duration 7d");

  console.log("test ok @dodo/api step10.1 auth crypto");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
