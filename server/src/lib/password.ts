import bcrypt from "bcryptjs";

// Cost 12 ≈ 100–250ms per hash — slow enough to blunt offline brute force and
// to naturally rate-limit login CPU.
// TODO(prod): prefer argon2id (memory-hard, GPU-resistant) over bcrypt.
const SALT_ROUNDS = 12;

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, SALT_ROUNDS);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}
