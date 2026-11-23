import { createHmac, timingSafeEqual } from "node:crypto";

// JWT mínimo (HS256) con node:crypto: sin librerías extra.
const SECRETO = () => process.env.JWT_SECRET as string;
const DURACION_SEGUNDOS = 24 * 60 * 60; // 24 horas

const b64 = (data: string | Buffer) => Buffer.from(data).toString("base64url");
const firmar = (contenido: string) =>
  createHmac("sha256", SECRETO()).update(contenido).digest("base64url");

export function crearToken(usuarioId: string): string {
  const ahora = Math.floor(Date.now() / 1000);
  const cabecera = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const cuerpo = b64(JSON.stringify({ sub: usuarioId, iat: ahora, exp: ahora + DURACION_SEGUNDOS }));
  return `${cabecera}.${cuerpo}.${firmar(`${cabecera}.${cuerpo}`)}`;
}

/** Devuelve el id del usuario si el token es válido y no ha expirado; si no, null. */
export function leerToken(token: string): string | null {
  const partes = token.split(".");
  if (partes.length !== 3) return null;
  const [cabecera, cuerpo, firma] = partes as [string, string, string];

  const esperada = Buffer.from(firmar(`${cabecera}.${cuerpo}`));
  const recibida = Buffer.from(firma);
  if (esperada.length !== recibida.length || !timingSafeEqual(esperada, recibida)) return null;

  try {
    const { sub, exp } = JSON.parse(Buffer.from(cuerpo, "base64url").toString("utf8")) as {
      sub?: unknown;
      exp?: unknown;
    };
    if (typeof sub !== "string" || typeof exp !== "number") return null;
    return exp > Math.floor(Date.now() / 1000) ? sub : null;
  } catch {
    return null;
  }
}
