import { createHmac, timingSafeEqual } from "node:crypto";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { z, ZodError } from "zod";
import { leerToken } from "./jwt";
import { aActorKeyAnonimo, aActorKeyUsuario, visitorIdSchema } from "./schema";

export type Event = APIGatewayProxyEventV2;
export type Result = APIGatewayProxyResultV2;

export type ActorIdentidad =
  | { tipo: "USER"; userId: string; actorKey: string }
  | { tipo: "ANON"; visitorId: string; actorKey: string };

export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export const json = (statusCode: number, body?: unknown): Result => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
});

function obtenerHeader(event: Event, nombre: string): string | undefined {
  const headers = event.headers;
  if (!headers) return undefined;
  const directo = headers[nombre] ?? headers[nombre.toLowerCase()];
  if (directo !== undefined) return directo;
  const objetivo = nombre.toLowerCase();
  for (const [clave, valor] of Object.entries(headers)) {
    if (clave.toLowerCase() === objetivo) return valor;
  }
  return undefined;
}

/** Id del usuario, leído del token "Authorization: Bearer <token>" que emite /login y /register. */
export function getUserId(event: Event): string {
  const [esquema, token] = (obtenerHeader(event, "authorization") ?? "").trim().split(/\s+/);
  const usuarioId = esquema?.toLowerCase() === "bearer" && token ? leerToken(token) : null;
  if (!usuarioId) throw new HttpError(401, "No autorizado");
  return usuarioId;
}

/**
 * Id del usuario si hay un token válido; si falta o no sirve (por ejemplo, expiró) devuelve null.
 * Uso exclusivo para rutas públicas de solo lectura. En mutaciones usar getUserId o getActorParaMutacion.
 */
export function getUserIdOpcional(event: Event): string | null {
  const [esquema, token] = (obtenerHeader(event, "authorization") ?? "").trim().split(/\s+/);
  return esquema?.toLowerCase() === "bearer" && token ? leerToken(token) : null;
}

/**
 * Lee y valida estrictamente el identificador anónimo en X-Visitor-Id.
 * - Devuelve null si el header no viene o viene vacío.
 * - Lanza 400 si el valor no cumple formato UUID válido.
 */
export function getVisitorIdEstrictoOpcional(event: Event): string | null {
  const bruto = obtenerHeader(event, "x-visitor-id")?.trim();
  if (!bruto) return null;
  const parsed = visitorIdSchema.safeParse(bruto);
  if (!parsed.success) {
    throw new HttpError(400, "El identificador de visitante no es válido");
  }
  return parsed.data.toLowerCase();
}

/**
 * Lee X-Visitor-Id sin lanzar errores si viene malformado (devuelve null).
 * Pensado para login/register: nunca debe bloquear la autenticación del usuario.
 */
export function getVisitorIdSeguro(event: Event): string | null {
  const bruto = obtenerHeader(event, "x-visitor-id")?.trim();
  if (!bruto) return null;
  const parsed = visitorIdSchema.safeParse(bruto);
  return parsed.success ? parsed.data.toLowerCase() : null;
}

/**
 * Lee X-Visitor-Token firmado (para migración segura verificable criptográficamente).
 * Devuelve null si falta o la firma es inválida.
 */
export function getVisitorTokenVerificado(event: Event): string | null {
  const bruto = obtenerHeader(event, "x-visitor-token")?.trim();
  if (!bruto) return null;
  return verificarVisitorToken(bruto);
}

/**
 * Resuelve la identidad para mutaciones híbridas (ej. likes):
 * - Si el cliente envía encabezado Authorization, DEBE ser un Bearer JWT válido; si es inválido o expiró
 *   responde HTTP 401 sin degradar silenciosamente a visitante.
 * - Si no envía Authorization, exige X-Visitor-Token firmado por el servidor (HTTP 400 si falta,
 *   está manipulado o si solo se envía un UUID crudo en X-Visitor-Id).
 */
export function getActorParaMutacion(event: Event): ActorIdentidad {
  const auth = obtenerHeader(event, "authorization")?.trim();
  if (auth) {
    const userId = getUserId(event);
    return { tipo: "USER", userId, actorKey: aActorKeyUsuario(userId) };
  }

  const rawToken = obtenerHeader(event, "x-visitor-token")?.trim();
  if (rawToken) {
    const verificado = verificarVisitorToken(rawToken);
    if (!verificado) {
      throw new HttpError(400, "El token de visitante no es válido");
    }
    return { tipo: "ANON", visitorId: verificado, actorKey: aActorKeyAnonimo(verificado) };
  }

  const rawVisitorId = obtenerHeader(event, "x-visitor-id")?.trim();
  if (rawVisitorId) {
    throw new HttpError(
      400,
      "Se requiere X-Visitor-Token firmado por el servidor para mutar likes como visitante",
    );
  }
  throw new HttpError(400, "Se requiere sesión o token de visitante");
}

/**
 * Resuelve identidad para lecturas públicas (catálogo y detalle):
 * - Prioriza JWT válido (USER#<id>); si expiró o no existe no bloquea la lectura.
 * - Si no hay sesión válida, usa X-Visitor-Token verificado por firma del servidor.
 */
export function getActorOpcionalLectura(event: Event): ActorIdentidad | null {
  const userId = getUserIdOpcional(event);
  if (userId) {
    return { tipo: "USER", userId, actorKey: aActorKeyUsuario(userId) };
  }
  const tokenVisitorId = getVisitorTokenVerificado(event);
  if (tokenVisitorId) {
    return { tipo: "ANON", visitorId: tokenVisitorId, actorKey: aActorKeyAnonimo(tokenVisitorId) };
  }
  return null;
}

/** Firma HMAC-SHA256 de soporte para evaluar tokens anónimos emitidos por el servidor. */
export function firmarVisitorToken(visitorId: string): string {
  const parsed = visitorIdSchema.parse(visitorId).toLowerCase();
  const secreto = process.env.JWT_SECRET as string;
  const firma = createHmac("sha256", secreto).update(`visitor:${parsed}`).digest("base64url");
  return `${parsed}.${firma}`;
}

export function verificarVisitorToken(token: string): string | null {
  const partes = token.split(".");
  if (partes.length !== 2) return null;
  const [id, firma] = partes as [string, string];
  const parsed = visitorIdSchema.safeParse(id);
  if (!parsed.success) return null;
  const normalizado = parsed.data.toLowerCase();
  const secreto = process.env.JWT_SECRET as string;
  const esperada = Buffer.from(
    createHmac("sha256", secreto).update(`visitor:${normalizado}`).digest("base64url"),
  );
  const recibida = Buffer.from(firma);
  if (esperada.length !== recibida.length || !timingSafeEqual(esperada, recibida)) return null;
  return normalizado;
}

const uuid = z.string().uuid();

export function getRecetaId(event: Event): string {
  const r = uuid.safeParse(event.pathParameters?.id);
  if (!r.success) throw new HttpError(400, "El id de la receta no es válido");
  return r.data;
}

export function parseBody<T extends z.ZodTypeAny>(event: Event, schema: T): z.output<T> {
  if (!event.body) throw new HttpError(400, "Falta el cuerpo de la petición");
  let raw: unknown;
  try {
    const texto = event.isBase64Encoded
      ? Buffer.from(event.body, "base64").toString("utf8")
      : event.body;
    raw = JSON.parse(texto);
  } catch {
    throw new HttpError(400, "El cuerpo no es un JSON válido");
  }
  return schema.parse(raw);
}

/** Envuelve un handler para convertir errores en respuestas HTTP consistentes. */
export const withErrors =
  (fn: (event: Event) => Promise<Result>) =>
  async (event: Event): Promise<Result> => {
    try {
      return await fn(event);
    } catch (err) {
      if (err instanceof HttpError) return json(err.statusCode, { error: err.message });
      if (err instanceof ZodError) {
        return json(400, {
          error: "Datos inválidos",
          detalles: err.issues.map((i) => ({ campo: i.path.join("."), mensaje: i.message })),
        });
      }
      console.error(err);
      return json(500, { error: "Error interno del servidor" });
    }
  };
