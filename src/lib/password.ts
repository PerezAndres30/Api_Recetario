import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

/** Guarda la contraseña como "salt:hash" (scrypt); nunca se almacena en texto plano. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, 64);
  return `${salt.toString("base64")}:${hash.toString("base64")}`;
}

export async function verificarPassword(password: string, guardado: string): Promise<boolean> {
  const [salt, hash] = guardado.split(":");
  if (!salt || !hash) return false;
  const esperado = Buffer.from(hash, "base64");
  const calculado = await scryptAsync(password, Buffer.from(salt, "base64"), esperado.length);
  return timingSafeEqual(esperado, calculado);
}
