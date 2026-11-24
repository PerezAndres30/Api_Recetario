import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { z, ZodError } from "zod";
import { leerToken } from "./jwt";

export type Event = APIGatewayProxyEventV2;
export type Result = APIGatewayProxyResultV2;

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

/** Id del usuario, leído del token "Authorization: Bearer <token>" que emite /login y /register. */
export function getUserId(event: Event): string {
  const [esquema, token] = (event.headers?.authorization ?? "").split(" ");
  const usuarioId = esquema?.toLowerCase() === "bearer" && token ? leerToken(token) : null;
  if (!usuarioId) throw new HttpError(401, "No autorizado");
  return usuarioId;
}

/**
 * Id del usuario si hay un token válido; si falta o no sirve (por ejemplo, expiró) devuelve null.
 * Para rutas públicas: un visitante con un token vencido sigue pudiendo explorar.
 */
export function getUserIdOpcional(event: Event): string | null {
  const [esquema, token] = (event.headers?.authorization ?? "").split(" ");
  return esquema?.toLowerCase() === "bearer" && token ? leerToken(token) : null;
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
