import {
  ConditionalCheckFailedException,
  TransactionCanceledException,
} from "@aws-sdk/client-dynamodb";
import { vi } from "vitest";
import { crearToken } from "../src/lib/jwt";
import type { Event } from "../src/lib/http";
import type { FavoritoItem, LikeItem, Receta } from "../src/lib/schema";
import type { UsuarioGuardado } from "../src/lib/sesion";

process.env.JWT_SECRET = "una-clave-de-prueba-de-al-menos-32-caracteres";

export const ID_A = "11111111-1111-4111-8111-111111111111"; // receta del usuario ana
export const ID_B = "22222222-2222-4222-8222-222222222222"; // receta del usuario beto
export const ID_NUEVA = "33333333-3333-4333-8333-333333333333";
export const VISITOR_1 = "44444444-4444-4444-8444-444444444444";
export const VISITOR_2 = "55555555-5555-4555-8555-555555555555";

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

export interface LockMigracionItem {
  recetaId: string;
  actorKey: string;
  actorTipo: "ANON";
  targetUserId: string;
  creadaEn: string;
}

export interface EstadoSimuladorDynamo {
  recetas: Receta[];
  usuarios: UsuarioGuardado[];
  likes: Array<LikeItem | LockMigracionItem>;
  favoritos: FavoritoItem[];
}

function evaluarCondicionReceta(r: Receta | undefined, expr?: string): boolean {
  if (!expr) return true;
  if (expr.includes("attribute_exists(recetaId)") && !r) return false;
  if (expr.includes("attribute_not_exists(favoritaMigradaEn)") && r?.favoritaMigradaEn) return false;
  if (expr.includes("likesCount >= :uno") && (!r || (r.likesCount ?? 0) < 1)) return false;
  return true;
}

/**
 * Simulador en memoria de DynamoDB (recetas, usuarios, likes con locks y favoritos)
 * compatible con Query, Scan, Get, Put, Update, Delete, BatchGet, BatchWrite y TransactWrite.
 */
export function tablaFalsa(
  inicial: Receta[],
  extras?: Partial<Omit<EstadoSimuladorDynamo, "recetas">>,
) {
  const items = [...inicial];
  const usuarios: UsuarioGuardado[] = [...(extras?.usuarios ?? [])];
  const likes: Array<LikeItem | LockMigracionItem> = [...(extras?.likes ?? [])];
  const favoritos: FavoritoItem[] = [...(extras?.favoritos ?? [])];

  const send = vi.fn(async (comando: { constructor: { name: string }; input: Record<string, any> }) => {
    const { input } = comando;
    const tableName: string = input.TableName ?? "recetas";

    switch (comando.constructor.name) {
      case "GetCommand": {
        if (tableName === "usuarios") {
          const item = usuarios.find((u) => u.correo === input.Key.correo);
          return { Item: item };
        }
        if (tableName === "favoritos") {
          const item = favoritos.find(
            (f) => f.userId === input.Key.userId && f.recetaId === input.Key.recetaId,
          );
          return { Item: item };
        }
        return { Item: undefined };
      }

      case "QueryCommand": {
        if (tableName === "recetas") {
          if (input.IndexName) {
            return {
              Items: items
                .filter((i) => i.recetaId === input.ExpressionAttributeValues[":r"])
                .slice(0, 1),
            };
          }
          return { Items: items.filter((i) => i.userId === input.ExpressionAttributeValues[":u"]) };
        }
        if (tableName === "likes") {
          const filtrados =
            input.IndexName === "actorKey-index"
              ? likes.filter((x) => x.actorKey === input.ExpressionAttributeValues[":a"])
              : likes.filter((x) => x.recetaId === input.ExpressionAttributeValues[":r"]);
          return { Items: filtrados };
        }
        if (tableName === "favoritos") {
          const filtrados =
            input.IndexName === "recetaId-index"
              ? favoritos.filter((x) => x.recetaId === input.ExpressionAttributeValues[":r"])
              : favoritos.filter((x) => x.userId === input.ExpressionAttributeValues[":u"]);
          return { Items: filtrados };
        }
        return { Items: [] };
      }

      case "ScanCommand":
        return { Items: [...items] };

      case "PutCommand": {
        if (tableName === "usuarios") {
          const idx = usuarios.findIndex((u) => u.correo === input.Item.correo);
          if (input.ConditionExpression?.includes("not_exists") && idx !== -1) {
            throw new ConditionalCheckFailedException({ message: "x", $metadata: {} });
          }
          if (idx === -1) usuarios.push(input.Item);
          else usuarios[idx] = input.Item;
          return {};
        }
        if (tableName === "likes") {
          const idx = likes.findIndex(
            (l) => l.recetaId === input.Item.recetaId && l.actorKey === input.Item.actorKey,
          );
          const actual = idx === -1 ? undefined : likes[idx];
          if (input.ConditionExpression?.includes("targetUserId = :targetUserId")) {
            const target = input.ExpressionAttributeValues?.[":targetUserId"];
            if (actual && (actual as LockMigracionItem).targetUserId !== target) {
              throw new ConditionalCheckFailedException({ message: "lock owned by other user", $metadata: {} });
            }
          } else if (input.ConditionExpression?.includes("not_exists") && idx !== -1) {
            throw new ConditionalCheckFailedException({ message: "x", $metadata: {} });
          }
          if (idx === -1) likes.push(input.Item);
          else likes[idx] = input.Item;
          return {};
        }
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

      case "UpdateCommand": {
        const idx = items.findIndex((i) => i.userId === input.Key.userId && i.recetaId === input.Key.recetaId);
        const actual = idx === -1 ? undefined : items[idx];
        if (!evaluarCondicionReceta(actual, input.ConditionExpression)) {
          throw new ConditionalCheckFailedException({ message: "x", $metadata: {} });
        }
        if (!actual) return {};
        const vals = input.ExpressionAttributeValues ?? {};
        const actualizada: Receta = {
          ...actual,
          titulo: ":titulo" in vals ? vals[":titulo"] : actual.titulo,
          descripcion: ":descripcion" in vals ? vals[":descripcion"] : actual.descripcion,
          categoria: ":categoria" in vals ? vals[":categoria"] : actual.categoria,
          tiempoMinutos: ":tiempoMinutos" in vals ? vals[":tiempoMinutos"] : actual.tiempoMinutos,
          porciones: ":porciones" in vals ? vals[":porciones"] : actual.porciones,
          ingredientes: ":ingredientes" in vals ? vals[":ingredientes"] : actual.ingredientes,
          pasos: ":pasos" in vals ? vals[":pasos"] : actual.pasos,
          favorita: ":favorita" in vals ? vals[":favorita"] : actual.favorita,
          imagenUrl: ":imagenUrl" in vals ? vals[":imagenUrl"] : actual.imagenUrl,
          imagenPublicId: ":imagenPublicId" in vals ? vals[":imagenPublicId"] : actual.imagenPublicId,
          tituloBusqueda: ":tituloBusqueda" in vals ? vals[":tituloBusqueda"] : actual.tituloBusqueda,
          actualizadaEn: ":actualizadaEn" in vals ? vals[":actualizadaEn"] : actual.actualizadaEn,
          favoritaMigradaEn:
            String(input.UpdateExpression).includes("favoritaMigradaEn = :ahora")
              ? vals[":ahora"]
              : actual.favoritaMigradaEn,
          likesCount: actual.likesCount ?? vals[":cero"] ?? 0,
        };
        items[idx] = actualizada;
        return { Attributes: actualizada };
      }

      case "DeleteCommand": {
        if (tableName === "likes") {
          const idx = likes.findIndex(
            (x) => x.recetaId === input.Key.recetaId && x.actorKey === input.Key.actorKey,
          );
          if (input.ConditionExpression?.includes("attribute_exists") && idx === -1) {
            throw new ConditionalCheckFailedException({ message: "x", $metadata: {} });
          }
          if (idx !== -1) likes.splice(idx, 1);
          return {};
        }
        if (tableName === "favoritos") {
          const idx = favoritos.findIndex(
            (x) => x.userId === input.Key.userId && x.recetaId === input.Key.recetaId,
          );
          if (idx !== -1) favoritos.splice(idx, 1);
          return {};
        }
        const idx = items.findIndex((i) => i.userId === input.Key.userId && i.recetaId === input.Key.recetaId);
        if (input.ConditionExpression?.includes("attribute_exists") && idx === -1) {
          throw new ConditionalCheckFailedException({ message: "x", $metadata: {} });
        }
        if (idx === -1) return {};
        const [borrada] = items.splice(idx, 1);
        return { Attributes: borrada };
      }

      case "BatchGetCommand": {
        const Responses: Record<string, unknown[]> = {};
        for (const [tabla, req] of Object.entries(
          input.RequestItems as Record<string, { Keys: Record<string, string>[] }>,
        )) {
          if (tabla === "likes") {
            Responses[tabla] = req.Keys.map((k) =>
              likes.find((x) => x.recetaId === k.recetaId && x.actorKey === k.actorKey),
            ).filter(Boolean);
          } else if (tabla === "recetas") {
            Responses[tabla] = req.Keys.map((k) =>
              items.find((x) => x.userId === k.userId && x.recetaId === k.recetaId),
            ).filter(Boolean);
          }
        }
        return { Responses };
      }

      case "BatchWriteCommand": {
        for (const [tabla, ops] of Object.entries(
          input.RequestItems as Record<string, Array<{ DeleteRequest: { Key: Record<string, string> } }>>,
        )) {
          for (const op of ops) {
            const k = op.DeleteRequest.Key;
            if (tabla === "likes") {
              const i = likes.findIndex((x) => x.recetaId === k.recetaId && x.actorKey === k.actorKey);
              if (i !== -1) likes.splice(i, 1);
            } else if (tabla === "favoritos") {
              const i = favoritos.findIndex((x) => x.userId === k.userId && x.recetaId === k.recetaId);
              if (i !== -1) favoritos.splice(i, 1);
            }
          }
        }
        return {};
      }

      case "TransactWriteCommand": {
        const txItems = input.TransactItems as Array<Record<string, any>>;
        const razones = txItems.map(() => ({ Code: "None" }));
        let cancelar = false;

        txItems.forEach((op, i) => {
          if (op.ConditionCheck?.TableName === "recetas") {
            const r = items.find(
              (x) => x.userId === op.ConditionCheck.Key.userId && x.recetaId === op.ConditionCheck.Key.recetaId,
            );
            if (!evaluarCondicionReceta(r, op.ConditionCheck.ConditionExpression)) {
              razones[i] = { Code: "ConditionalCheckFailed" };
              cancelar = true;
            }
          }
          if (op.Update?.TableName === "recetas") {
            const r = items.find(
              (x) => x.userId === op.Update.Key.userId && x.recetaId === op.Update.Key.recetaId,
            );
            if (!evaluarCondicionReceta(r, op.Update.ConditionExpression)) {
              razones[i] = { Code: "ConditionalCheckFailed" };
              cancelar = true;
            }
          }
          if (op.Put?.TableName === "likes") {
            const existe = likes.some(
              (x) => x.recetaId === op.Put.Item.recetaId && x.actorKey === op.Put.Item.actorKey,
            );
            if (op.Put.ConditionExpression?.includes("attribute_not_exists") && existe) {
              razones[i] = { Code: "ConditionalCheckFailed" };
              cancelar = true;
            }
          }
          if (op.Delete?.TableName === "likes") {
            const existe = likes.some(
              (x) => x.recetaId === op.Delete.Key.recetaId && x.actorKey === op.Delete.Key.actorKey,
            );
            if (op.Delete.ConditionExpression?.includes("attribute_exists") && !existe) {
              razones[i] = { Code: "ConditionalCheckFailed" };
              cancelar = true;
            }
          }
          if (op.Put?.TableName === "favoritos") {
            const existe = favoritos.some(
              (x) => x.userId === op.Put.Item.userId && x.recetaId === op.Put.Item.recetaId,
            );
            if (op.Put.ConditionExpression?.includes("attribute_not_exists") && existe) {
              razones[i] = { Code: "ConditionalCheckFailed" };
              cancelar = true;
            }
          }
        });

        if (cancelar) {
          throw new TransactionCanceledException({
            message: "Transaction cancelled",
            $metadata: {},
            CancellationReasons: razones,
          });
        }

        for (const op of txItems) {
          if (op.Update?.TableName === "recetas") {
            const r = items.find(
              (x) => x.userId === op.Update.Key.userId && x.recetaId === op.Update.Key.recetaId,
            )!;
            const addMatch = String(op.Update.UpdateExpression).match(/ADD\s+likesCount\s+(:[A-Za-z0-9_]+)/);
            if (addMatch?.[1]) {
              const delta = op.Update.ExpressionAttributeValues[addMatch[1]] as number;
              r.likesCount = (r.likesCount ?? 0) + delta;
            }
            if (String(op.Update.UpdateExpression).includes("favoritaMigradaEn = :ahora")) {
              r.favoritaMigradaEn = op.Update.ExpressionAttributeValues[":ahora"] as string;
            }
          }
          if (op.Put?.TableName === "likes") {
            likes.push(op.Put.Item);
          }
          if (op.Delete?.TableName === "likes") {
            const i = likes.findIndex(
              (x) => x.recetaId === op.Delete.Key.recetaId && x.actorKey === op.Delete.Key.actorKey,
            );
            if (i !== -1) likes.splice(i, 1);
          }
          if (op.Put?.TableName === "favoritos") {
            favoritos.push(op.Put.Item);
          }
        }
        return {};
      }

      default:
        throw new Error(`Comando no esperado: ${comando.constructor.name}`);
    }
  });

  return { items, usuarios, likes, favoritos, send };
}

export function evento(opciones: {
  token?: string;
  visitorId?: string;
  visitorToken?: string;
  id?: string;
  body?: unknown;
  query?: Record<string, string>;
  headers?: Record<string, string>;
}): Event {
  const headers: Record<string, string> = { ...(opciones.headers ?? {}) };
  if (opciones.token) headers.authorization = `Bearer ${opciones.token}`;
  if (opciones.visitorId) headers["x-visitor-id"] = opciones.visitorId;
  if (opciones.visitorToken) headers["x-visitor-token"] = opciones.visitorToken;
  return {
    headers,
    pathParameters: opciones.id ? { id: opciones.id } : undefined,
    body: opciones.body === undefined ? undefined : JSON.stringify(opciones.body),
    queryStringParameters: opciones.query,
  } as unknown as Event;
}

export const cuerpo = (r: { body?: string }) => (r.body ? JSON.parse(r.body) : undefined);
