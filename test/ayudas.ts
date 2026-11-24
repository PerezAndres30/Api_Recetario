import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { vi } from "vitest";
import { crearToken } from "../src/lib/jwt";
import type { Event } from "../src/lib/http";
import type { Receta } from "../src/lib/schema";

process.env.JWT_SECRET = "una-clave-de-prueba-de-al-menos-32-caracteres";

export const ID_A = "11111111-1111-4111-8111-111111111111"; // receta del usuario ana
export const ID_B = "22222222-2222-4222-8222-222222222222"; // receta del usuario beto
export const ID_NUEVA = "33333333-3333-4333-8333-333333333333";

export const tokenDe = (usuarioId: string) => crearToken(usuarioId);

export function receta(parcial: Partial<Receta> & Pick<Receta, "userId" | "recetaId">): Receta {
  return {
    titulo: "Pastel",
    descripcion: "",
    categoria: "postre",
    tiempoMinutos: 30,
    porciones: 4,
    ingredientes: [{ nombre: "Harina", cantidad: "1", unidad: "taza" }],
    pasos: ["Mezclar"],
    favorita: false,
    tituloBusqueda: "pastel",
    creadaEn: "2026-11-01T00:00:00.000Z",
    actualizadaEn: "2026-11-01T00:00:00.000Z",
    ...parcial,
  };
}

/** Tabla de recetas en memoria que imita lo que usan los handlers (Query, Scan, Put y Delete). */
export function tablaFalsa(inicial: Receta[]) {
  const items = [...inicial];
  const send = vi.fn(async (comando: { constructor: { name: string }; input: Record<string, any> }) => {
    const { input } = comando;
    switch (comando.constructor.name) {
      case "QueryCommand": {
        if (input.IndexName) {
          return { Items: items.filter((i) => i.recetaId === input.ExpressionAttributeValues[":r"]).slice(0, 1) };
        }
        return { Items: items.filter((i) => i.userId === input.ExpressionAttributeValues[":u"]) };
      }
      case "ScanCommand":
        return { Items: [...items] };
      case "PutCommand": {
        const idx = items.findIndex((i) => i.userId === input.Item.userId && i.recetaId === input.Item.recetaId);
        if (input.ConditionExpression?.includes("not_exists") && idx !== -1) {
          throw new ConditionalCheckFailedException({ message: "x", $metadata: {} });
        }
        if (input.ConditionExpression?.includes("attribute_exists") && idx === -1) {
          throw new ConditionalCheckFailedException({ message: "x", $metadata: {} });
        }
        if (idx === -1) items.push(input.Item);
        else items[idx] = input.Item;
        return {};
      }
      case "DeleteCommand": {
        const idx = items.findIndex((i) => i.userId === input.Key.userId && i.recetaId === input.Key.recetaId);
        if (idx === -1) return {};
        const [borrada] = items.splice(idx, 1);
        return { Attributes: borrada };
      }
      default:
        throw new Error(`Comando no esperado: ${comando.constructor.name}`);
    }
  });
  return { items, send };
}

export function evento(opciones: {
  token?: string;
  id?: string;
  body?: unknown;
  query?: Record<string, string>;
}): Event {
  return {
    headers: opciones.token ? { authorization: `Bearer ${opciones.token}` } : {},
    pathParameters: opciones.id ? { id: opciones.id } : undefined,
    body: opciones.body === undefined ? undefined : JSON.stringify(opciones.body),
    queryStringParameters: opciones.query,
  } as unknown as Event;
}

export const cuerpo = (r: { body?: string }) => (r.body ? JSON.parse(r.body) : undefined);
