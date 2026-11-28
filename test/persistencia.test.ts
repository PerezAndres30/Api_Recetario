import {
  ConditionalCheckFailedException,
  TransactionCanceledException,
} from "@aws-sdk/client-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FavoritoItem, LikeItem, Receta } from "../src/lib/schema";
import { evento, ID_A, ID_B, ID_NUEVA, receta, tokenDe } from "./ayudas";

const tablas = vi.hoisted(() => ({ send: vi.fn() }));

vi.mock("../src/lib/clients", () => ({
  ddb: tablas,
  TABLE: "recetas",
  USUARIOS_TABLE: "usuarios",
  LIKES_TABLE: "likes",
  FAVORITOS_TABLE: "favoritos",
  INDICE_RECETA_ID: "recetaId-index",
  INDICE_ACTOR_KEY: "actorKey-index",
}));

import { batchDeleteConReintentos, batchGetConReintentos, queryPaginado } from "../src/lib/dynamo";
import {
  agregarFavoritoSeguro,
  consultarFavoritosIds,
  eliminarFavoritosDeReceta,
  listarFavoritosHidratados,
  quitarFavorito,
} from "../src/lib/favoritos";
import {
  firmarVisitorToken,
  getActorOpcionalLectura,
  getActorParaMutacion,
  getVisitorIdEstrictoOpcional,
  getVisitorIdSeguro,
  HttpError,
  verificarVisitorToken,
} from "../src/lib/http";
import {
  consultarLikesDeActor,
  darLikeAtomico,
  eliminarLikesDeReceta,
  migrarLikesAnonimos,
  migrarLikesAnonimosSeguro,
  quitarLikeAtomico,
} from "../src/lib/likes";
import {
  aActorKeyAnonimo,
  aActorKeyUsuario,
  aRespuesta,
  actualizarInput,
  crearInput,
  normalizarLikesCount,
} from "../src/lib/schema";

const VISITOR_1 = "44444444-4444-4444-8444-444444444444";
const VISITOR_2 = "55555555-5555-4555-8555-555555555555";

interface EstadoTablas {
  recetas: Receta[];
  likes: LikeItem[];
  favoritos: FavoritoItem[];
}

function crearSimuladorDynamo(inicial?: Partial<EstadoTablas>) {
  const estado: EstadoTablas = {
    recetas: [...(inicial?.recetas ?? [])],
    likes: [...(inicial?.likes ?? [])],
    favoritos: [...(inicial?.favoritos ?? [])],
  };

  function evaluarCondicionReceta(r: Receta | undefined, expr?: string): boolean {
    if (!expr) return true;
    if (expr.includes("attribute_exists(recetaId)") && !r) return false;
    if (expr.includes("likesCount >= :uno") && (!r || (r.likesCount ?? 0) < 1)) return false;
    return true;
  }

  const send = vi.fn(async (comando: { constructor: { name: string }; input: Record<string, any> }) => {
    const { input } = comando;
    switch (comando.constructor.name) {
      case "QueryCommand": {
        if (input.TableName === "recetas" && input.IndexName === "recetaId-index") {
          const rId = input.ExpressionAttributeValues[":r"];
          return { Items: estado.recetas.filter((x) => x.recetaId === rId).slice(0, 1) };
        }
        if (input.TableName === "likes") {
          const filtrados =
            input.IndexName === "actorKey-index"
              ? estado.likes.filter((x) => x.actorKey === input.ExpressionAttributeValues[":a"])
              : estado.likes.filter((x) => x.recetaId === input.ExpressionAttributeValues[":r"]);
          return { Items: filtrados };
        }
        if (input.TableName === "favoritos") {
          const filtrados =
            input.IndexName === "recetaId-index"
              ? estado.favoritos.filter((x) => x.recetaId === input.ExpressionAttributeValues[":r"])
              : estado.favoritos.filter((x) => x.userId === input.ExpressionAttributeValues[":u"]);
          return { Items: filtrados };
        }
        return { Items: [] };
      }
      case "DeleteCommand": {
        if (input.TableName === "likes") {
          const idx = estado.likes.findIndex(
            (x) => x.recetaId === input.Key.recetaId && x.actorKey === input.Key.actorKey,
          );
          if (input.ConditionExpression?.includes("attribute_exists") && idx === -1) {
            throw new ConditionalCheckFailedException({ message: "x", $metadata: {} });
          }
          if (idx !== -1) estado.likes.splice(idx, 1);
          return {};
        }
        if (input.TableName === "favoritos") {
          const idx = estado.favoritos.findIndex(
            (x) => x.userId === input.Key.userId && x.recetaId === input.Key.recetaId,
          );
          if (idx !== -1) estado.favoritos.splice(idx, 1);
          return {};
        }
        return {};
      }
      case "BatchGetCommand": {
        const Responses: Record<string, unknown[]> = {};
        for (const [tabla, req] of Object.entries(input.RequestItems as Record<string, { Keys: Record<string, string>[] }>)) {
          if (tabla === "likes") {
            Responses[tabla] = req.Keys.map((k) =>
              estado.likes.find((x) => x.recetaId === k.recetaId && x.actorKey === k.actorKey),
            ).filter(Boolean);
          } else if (tabla === "recetas") {
            Responses[tabla] = req.Keys.map((k) =>
              estado.recetas.find((x) => x.userId === k.userId && x.recetaId === k.recetaId),
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
              const i = estado.likes.findIndex((x) => x.recetaId === k.recetaId && x.actorKey === k.actorKey);
              if (i !== -1) estado.likes.splice(i, 1);
            } else if (tabla === "favoritos") {
              const i = estado.favoritos.findIndex((x) => x.userId === k.userId && x.recetaId === k.recetaId);
              if (i !== -1) estado.favoritos.splice(i, 1);
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
          if (op.ConditionCheck && op.ConditionCheck.TableName === "recetas") {
            const r = estado.recetas.find(
              (x) => x.userId === op.ConditionCheck.Key.userId && x.recetaId === op.ConditionCheck.Key.recetaId,
            );
            if (!evaluarCondicionReceta(r, op.ConditionCheck.ConditionExpression)) {
              razones[i] = { Code: "ConditionalCheckFailed" };
              cancelar = true;
            }
          }
          if (op.Update && op.Update.TableName === "recetas") {
            const r = estado.recetas.find(
              (x) => x.userId === op.Update.Key.userId && x.recetaId === op.Update.Key.recetaId,
            );
            if (!evaluarCondicionReceta(r, op.Update.ConditionExpression)) {
              razones[i] = { Code: "ConditionalCheckFailed" };
              cancelar = true;
            }
          }
          if (op.Put && op.Put.TableName === "likes") {
            const existe = estado.likes.some(
              (x) => x.recetaId === op.Put.Item.recetaId && x.actorKey === op.Put.Item.actorKey,
            );
            if (op.Put.ConditionExpression?.includes("attribute_not_exists") && existe) {
              razones[i] = { Code: "ConditionalCheckFailed" };
              cancelar = true;
            }
          }
          if (op.Delete && op.Delete.TableName === "likes") {
            const existe = estado.likes.some(
              (x) => x.recetaId === op.Delete.Key.recetaId && x.actorKey === op.Delete.Key.actorKey,
            );
            if (op.Delete.ConditionExpression?.includes("attribute_exists") && !existe) {
              razones[i] = { Code: "ConditionalCheckFailed" };
              cancelar = true;
            }
          }
          if (op.Put && op.Put.TableName === "favoritos") {
            const existe = estado.favoritos.some(
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
          if (op.Update && op.Update.TableName === "recetas") {
            const r = estado.recetas.find(
              (x) => x.userId === op.Update.Key.userId && x.recetaId === op.Update.Key.recetaId,
            )!;
            const match = String(op.Update.UpdateExpression).match(/ADD\s+likesCount\s+(:[A-Za-z0-9_]+)/);
            const deltaKey = match?.[1];
            const delta = (deltaKey ? op.Update.ExpressionAttributeValues[deltaKey] : 0) as number;
            r.likesCount = (r.likesCount ?? 0) + delta;
          }
          if (op.Put && op.Put.TableName === "likes") {
            estado.likes.push(op.Put.Item);
          }
          if (op.Delete && op.Delete.TableName === "likes") {
            const i = estado.likes.findIndex(
              (x) => x.recetaId === op.Delete.Key.recetaId && x.actorKey === op.Delete.Key.actorKey,
            );
            if (i !== -1) estado.likes.splice(i, 1);
          }
          if (op.Put && op.Put.TableName === "favoritos") {
            estado.favoritos.push(op.Put.Item);
          }
        }
        return {};
      }
      case "PutCommand": {
        if (input.TableName === "likes") {
          const idx = estado.likes.findIndex(
            (l) => l.recetaId === input.Item.recetaId && l.actorKey === input.Item.actorKey,
          );
          if (idx === -1) estado.likes.push(input.Item);
          else estado.likes[idx] = input.Item;
        }
        return {};
      }
      default:
        throw new Error(`Comando no simulado: ${comando.constructor.name}`);
    }
  });

  return { estado, send };
}

let sim: ReturnType<typeof crearSimuladorDynamo>;

beforeEach(() => {
  process.env.JWT_SECRET = "una-clave-de-prueba-de-al-menos-32-caracteres";
  sim = crearSimuladorDynamo({
    recetas: [
      receta({ userId: "ana", recetaId: ID_A, titulo: "Pastel", favorita: true }), // sin likesCount (histórica)
      receta({ userId: "beto", recetaId: ID_B, titulo: "Tacos", likesCount: 2 }),
    ],
  });
  tablas.send.mockReset();
  tablas.send.mockImplementation(sim.send);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("esquemas Zod y normalización de Receta", () => {
  it("interpreta recetas históricas sin likesCount o con valores inválidos como 0", () => {
    expect(normalizarLikesCount(undefined)).toBe(0);
    expect(normalizarLikesCount(-5)).toBe(0);
    expect(normalizarLikesCount(4.8)).toBe(4);
    const historica = aRespuesta(sim.estado.recetas[0]!, null);
    expect(historica.likesCount).toBe(0);
    expect(historica.favorita).toBe(true);
  });

  it("impide inyectar likesCount mediante crearInput y actualizarInput", () => {
    const base = {
      titulo: "Flan",
      categoria: "postre",
      tiempoMinutos: 40,
      porciones: 4,
      ingredientes: [{ nombre: "Huevo" }],
      pasos: ["Hornear"],
      likesCount: 9999,
    };
    const parsedCrear = crearInput.parse(base);
    expect("likesCount" in parsedCrear).toBe(false);

    const parsedAct = actualizarInput.parse(base);
    expect("likesCount" in parsedAct).toBe(false);
    expect(parsedAct.favorita).toBeUndefined();
  });
});

describe("identidad híbrida, validación estricta y token anónimo firmado", () => {
  it("rechaza con 401 token inválido o expirado en mutaciones sin degradar a visitante", () => {
    const ev = evento({});
    ev.headers = {
      authorization: "Bearer token.invalido.firma",
      "x-visitor-id": VISITOR_1,
    };
    expect(() => getActorParaMutacion(ev)).toThrowError(HttpError);
    try {
      getActorParaMutacion(ev);
    } catch (e) {
      expect((e as HttpError).statusCode).toBe(401);
    }
  });

  it("prioriza identidad autenticada cuando el JWT es válido", () => {
    const ev = evento({ token: tokenDe("ana") });
    ev.headers["X-Visitor-Id"] = VISITOR_1;
    expect(getActorParaMutacion(ev)).toEqual({
      tipo: "USER",
      userId: "ana",
      actorKey: aActorKeyUsuario("ana"),
    });
  });

  it("exige X-Visitor-Token firmado cuando no hay sesión en mutaciones y rechaza UUID crudo sin firma", () => {
    expect(() => getActorParaMutacion(evento({}))).toThrowError("Se requiere sesión o token de visitante");

    const evSoloUuid = evento({ visitorId: VISITOR_1 });
    expect(() => getActorParaMutacion(evSoloUuid)).toThrowError("Se requiere X-Visitor-Token firmado");

    const evTokenManipulado = evento({ visitorToken: `${VISITOR_1}.firmamala` });
    expect(() => getActorParaMutacion(evTokenManipulado)).toThrowError("El token de visitante no es válido");

    const evMalo = evento({ visitorId: "no-es-uuid" });
    expect(() => getVisitorIdEstrictoOpcional(evMalo)).toThrowError("El identificador de visitante no es válido");
    expect(getVisitorIdSeguro(evMalo)).toBeNull();

    const evFirmado = evento({ visitorToken: firmarVisitorToken(VISITOR_1) });
    expect(getActorParaMutacion(evFirmado)).toEqual({
      tipo: "ANON",
      visitorId: VISITOR_1,
      actorKey: aActorKeyAnonimo(VISITOR_1),
    });
  });

  it("en lectura pública un token expirado no bloquea y usa X-Visitor-Token firmado si es válido", () => {
    const ev = evento({ token: "invalido.jwt.token", visitorToken: firmarVisitorToken(VISITOR_1) });
    expect(getActorOpcionalLectura(ev)).toEqual({
      tipo: "ANON",
      visitorId: VISITOR_1,
      actorKey: aActorKeyAnonimo(VISITOR_1),
    });
    // UUID crudo sin firma tampoco identifica actor en lectura
    expect(getActorOpcionalLectura(evento({ visitorId: VISITOR_1 }))).toBeNull();
  });

  it("firma y verifica tokens de visitante anónimo detectando manipulación", () => {
    const firmado = firmarVisitorToken(VISITOR_1);
    expect(verificarVisitorToken(firmado)).toBe(VISITOR_1);
    expect(verificarVisitorToken(`${VISITOR_2}.${firmado.split(".")[1]}`)).toBeNull();
    expect(verificarVisitorToken("invalido")).toBeNull();
  });
});

describe("auxiliares DynamoDB: paginación, UnprocessedKeys y UnprocessedItems", () => {
  it("recorre todas las páginas en queryPaginado", async () => {
    tablas.send
      .mockResolvedValueOnce({ Items: [{ id: 1 }], LastEvaluatedKey: { k: "1" } })
      .mockResolvedValueOnce({ Items: [{ id: 2 }], LastEvaluatedKey: undefined });

    const res = await queryPaginado<{ id: number }>({ TableName: "likes" });
    expect(res).toEqual([{ id: 1 }, { id: 2 }]);
    expect(tablas.send).toHaveBeenCalledTimes(2);
  });

  it("reintenta UnprocessedKeys y deduplica claves repetidas en batchGetConReintentos", async () => {
    tablas.send
      .mockResolvedValueOnce({
        Responses: { likes: [{ recetaId: ID_A, actorKey: "USER#ana" }] },
        UnprocessedKeys: { likes: { Keys: [{ recetaId: ID_B, actorKey: "USER#ana" }] } },
      })
      .mockResolvedValueOnce({
        Responses: { likes: [{ recetaId: ID_B, actorKey: "USER#ana" }] },
        UnprocessedKeys: {},
      });

    const items = await batchGetConReintentos(
      "likes",
      [
        { recetaId: ID_A, actorKey: "USER#ana" },
        { recetaId: ID_A, actorKey: "USER#ana" }, // duplicado
        { recetaId: ID_B, actorKey: "USER#ana" },
      ],
      { esperarMs: async () => {} },
    );

    expect(items).toHaveLength(2);
    expect(tablas.send).toHaveBeenCalledTimes(2);
  });

  it("divide en lotes de 25 y reintenta UnprocessedItems en batchDeleteConReintentos", async () => {
    const claves = Array.from({ length: 30 }, (_, i) => ({
      recetaId: ID_A,
      actorKey: `ANON#00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    }));

    tablas.send
      .mockResolvedValueOnce({
        UnprocessedItems: { likes: [{ DeleteRequest: { Key: claves[0]! } }] },
      })
      .mockResolvedValueOnce({ UnprocessedItems: {} })
      .mockResolvedValueOnce({ UnprocessedItems: {} });

    const res = await batchDeleteConReintentos("likes", claves, { esperarMs: async () => {} });
    expect(res.eliminadosSolicitados).toBe(30);
    expect(tablas.send).toHaveBeenCalledTimes(3);
  });
});

describe("capa de persistencia de likes y migración anónima", () => {
  it("da y quita likes atómicamente de forma idempotente sin permitir contadores negativos", async () => {
    const anonKey = aActorKeyAnonimo(VISITOR_1);
    expect(await darLikeAtomico(ID_A, anonKey, "ANON")).toEqual({
      recetaId: ID_A,
      likesCount: 1,
      leDiLike: true,
    });
    // Segundo like idempotente no duplica contador
    expect(await darLikeAtomico(ID_A, anonKey, "ANON")).toEqual({
      recetaId: ID_A,
      likesCount: 1,
      leDiLike: true,
    });

    expect(await quitarLikeAtomico(ID_A, anonKey)).toEqual({
      recetaId: ID_A,
      likesCount: 0,
      leDiLike: false,
    });
    // Segundo unlike idempotente nunca deja contador en -1
    expect(await quitarLikeAtomico(ID_A, anonKey)).toEqual({
      recetaId: ID_A,
      likesCount: 0,
      leDiLike: false,
    });
    expect(sim.estado.recetas.find((r) => r.recetaId === ID_A)?.likesCount).toBe(0);
  });

  it("rechaza con 404 dar o quitar like en recetas inexistentes", async () => {
    await expect(darLikeAtomico(ID_NUEVA, aActorKeyUsuario("ana"), "USER")).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(quitarLikeAtomico(ID_NUEVA, aActorKeyUsuario("ana"))).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("migra likes anónimos y deduplica cuando la cuenta ya tenía like previo", async () => {
    const anonKey = aActorKeyAnonimo(VISITOR_1);
    const userKey = aActorKeyUsuario("ana");

    // Ana ya dio like a ID_B; como visitante dio like a ID_A (nueva para Ana) y a ID_B (duplicado)
    await darLikeAtomico(ID_B, userKey, "USER"); // ID_B: 2 -> 3
    await darLikeAtomico(ID_A, anonKey, "ANON"); // ID_A: 0 -> 1
    await darLikeAtomico(ID_B, anonKey, "ANON"); // ID_B: 3 -> 4

    // Registro huérfano en LikesTable de receta ya borrada
    sim.estado.likes.push({
      recetaId: ID_NUEVA,
      actorKey: anonKey,
      actorTipo: "ANON",
      creadaEn: "2026-11-01T00:00:00.000Z",
    });

    const resumen = await migrarLikesAnonimos(VISITOR_1, "ana");
    expect(resumen).toEqual({
      migrados: 1,
      deduplicados: 1,
      huerfanosLimpiados: 1,
      bloqueadaPorOtraCuenta: false,
      parcial: false,
    });

    // ID_A conservó 1 like y pasó a USER#ana; ID_B bajó de 4 a 3 por deduplicación; no quedan ANON#
    expect(sim.estado.recetas.find((r) => r.recetaId === ID_A)?.likesCount).toBe(1);
    expect(sim.estado.recetas.find((r) => r.recetaId === ID_B)?.likesCount).toBe(3);
    expect(sim.estado.likes.filter((l) => l.actorKey === anonKey && l.recetaId !== "__MIGRACION_LOCK__")).toHaveLength(0);

    const likesAna = await consultarLikesDeActor([ID_A, ID_B], userKey);
    expect([...likesAna].sort()).toEqual([ID_A, ID_B].sort());

    // Segunda ejecución es completamente idempotente
    expect(await migrarLikesAnonimos(VISITOR_1, "ana")).toEqual({
      migrados: 0,
      deduplicados: 0,
      huerfanosLimpiados: 0,
      bloqueadaPorOtraCuenta: false,
      parcial: false,
    });
  });

  it("migrarLikesAnonimosSeguro no interrumpe el login si falla DynamoDB", async () => {
    tablas.send.mockRejectedValueOnce(new Error("DynamoDB temporalmente no disponible"));
    const res = await migrarLikesAnonimosSeguro(VISITOR_1, "ana");
    expect(res).toBeNull();
  });

  it("limpia todos los likes de una receta eliminada", async () => {
    await darLikeAtomico(ID_A, aActorKeyUsuario("ana"), "USER");
    await darLikeAtomico(ID_A, aActorKeyAnonimo(VISITOR_1), "ANON");
    const eliminados = await eliminarLikesDeReceta(ID_A);
    expect(eliminados).toBe(2);
    expect(sim.estado.likes.filter((l) => l.recetaId === ID_A)).toHaveLength(0);
  });
});

describe("capa de persistencia de favoritos", () => {
  it("guarda recetas propias o ajenas de forma idempotente e impide guardar recetas eliminadas", async () => {
    await expect(agregarFavoritoSeguro("ana", ID_NUEVA)).rejects.toMatchObject({ statusCode: 404 });

    expect(await agregarFavoritoSeguro("ana", ID_B)).toEqual({ recetaId: ID_B, esFavorito: true });
    expect(await agregarFavoritoSeguro("ana", ID_A)).toEqual({ recetaId: ID_A, esFavorito: true });
    // Repetir el mismo favorito es idempotente
    expect(await agregarFavoritoSeguro("ana", ID_B)).toEqual({ recetaId: ID_B, esFavorito: true });

    const ids = await consultarFavoritosIds("ana");
    expect(ids.has(ID_A)).toBe(true);
    expect(ids.has(ID_B)).toBe(true);

    const hidratadas = await listarFavoritosHidratados("ana");
    expect(hidratadas).toHaveLength(2);

    expect(await quitarFavorito("ana", ID_A)).toEqual({ recetaId: ID_A, esFavorito: false });
    expect((await consultarFavoritosIds("ana")).has(ID_A)).toBe(false);
  });

  it("limpia favoritos relacionados al borrar una receta", async () => {
    await agregarFavoritoSeguro("ana", ID_B);
    await agregarFavoritoSeguro("beto", ID_B);
    const limpiados = await eliminarFavoritosDeReceta(ID_B);
    expect(limpiados).toBe(2);
    expect(sim.estado.favoritos).toHaveLength(0);
  });
});
