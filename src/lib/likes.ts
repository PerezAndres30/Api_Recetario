import {
  ConditionalCheckFailedException,
  TransactionCanceledException,
} from "@aws-sdk/client-dynamodb";
import { DeleteCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, INDICE_ACTOR_KEY, LIKES_TABLE, TABLE } from "./clients";
import {
  batchDeleteConReintentos,
  batchGetConReintentos,
  queryPaginado,
  transactWriteConReintentos,
  type OpcionesReintentoBatch,
} from "./dynamo";
import { HttpError } from "./http";
import { buscarReceta } from "./recetas";
import {
  aActorKeyAnonimo,
  aActorKeyUsuario,
  normalizarLikesCount,
  type ActorTipo,
  type LikeItem,
} from "./schema";

export const LOCK_MIGRACION_RECETA_ID = "__MIGRACION_LOCK__";
export const LIMPIEZA_PENDIENTE_ACTOR_KEY = "__LIMPIEZA_PENDIENTE__";

export interface EstadoLikeReceta {
  recetaId: string;
  likesCount: number;
  leDiLike: boolean;
}

export interface ResultadoMigracionLikes {
  migrados: number;
  deduplicados: number;
  huerfanosLimpiados: number;
  bloqueadaPorOtraCuenta: boolean;
  parcial: boolean;
}

export interface OpcionesMigracionLikes extends OpcionesReintentoBatch {
  /** IDs conocidos por el cliente/sesión para mitigar la consistencia eventual del GSI actorKey-index. */
  recetaIdsConocidas?: string[];
  /** Presupuesto de tiempo para no bloquear el login ni acercarse al timeout de Lambda. */
  tiempoMaximoMs?: number;
  /** Límite de elementos procesados en una misma invocación síncrona. */
  maxItems?: number;
}

function razonCancelacion(err: unknown, indice: number): string | undefined {
  if (!(err instanceof TransactionCanceledException)) return undefined;
  return err.CancellationReasons?.[indice]?.Code;
}

function esCondicionFallida(err: unknown, indice: number): boolean {
  return razonCancelacion(err, indice) === "ConditionalCheckFailed";
}

function esConflictoTransaccional(err: unknown): boolean {
  if (err instanceof TransactionCanceledException) {
    return (err.CancellationReasons ?? []).some(
      (r) => r.Code === "TransactionConflict" || r.Code === "ProvisionedThroughputExceeded",
    );
  }
  const nombre = (err as { name?: string } | null)?.name;
  return nombre === "TransactionConflictException" || nombre === "ProvisionedThroughputExceededException";
}

async function borrarLikeSilencioso(recetaId: string, actorKey: string): Promise<void> {
  try {
    await ddb.send(
      new DeleteCommand({
        TableName: LIKES_TABLE,
        Key: { recetaId, actorKey },
        ConditionExpression: "attribute_exists(actorKey)",
      }),
    );
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) return;
    throw err;
  }
}

/**
 * Registra un like de forma atómica e idempotente para un actor (USER# o ANON#).
 * - Falla con 404 si la receta no existe o fue eliminada concurrentemente.
 * - Reintenta conflictos transitorios y devuelve 409 si persisten.
 * - Solo trata como idempotente un ConditionalCheckFailed específico de clave ya existente.
 */
export async function darLikeAtomico(
  recetaId: string,
  actorKey: string,
  actorTipo: ActorTipo,
  opciones?: OpcionesReintentoBatch,
): Promise<EstadoLikeReceta> {
  const receta = await buscarReceta(recetaId);
  if (!receta) throw new HttpError(404, "Receta no encontrada");

  const nuevoLike: LikeItem = {
    recetaId,
    actorKey,
    actorTipo,
    creadaEn: new Date().toISOString(),
  };

  try {
    await transactWriteConReintentos(
      {
        TransactItems: [
          {
            Update: {
              TableName: TABLE,
              Key: { userId: receta.userId, recetaId },
              UpdateExpression: "ADD likesCount :uno",
              ConditionExpression: "attribute_exists(recetaId)",
              ExpressionAttributeValues: { ":uno": 1 },
            },
          },
          {
            Put: {
              TableName: LIKES_TABLE,
              Item: nuevoLike,
              ConditionExpression: "attribute_not_exists(actorKey)",
            },
          },
        ],
      },
      opciones,
    );

    const actualizado = await buscarReceta(recetaId);
    return {
      recetaId,
      likesCount: normalizarLikesCount(actualizado?.likesCount ?? normalizarLikesCount(receta.likesCount) + 1),
      leDiLike: true,
    };
  } catch (err) {
    if (err instanceof TransactionCanceledException) {
      if (esCondicionFallida(err, 0)) {
        throw new HttpError(404, "Receta no encontrada");
      }
      if (esCondicionFallida(err, 1)) {
        const actual = await buscarReceta(recetaId);
        if (!actual) throw new HttpError(404, "Receta no encontrada");
        return {
          recetaId,
          likesCount: normalizarLikesCount(actual.likesCount),
          leDiLike: true,
        };
      }
    }
    if (esConflictoTransaccional(err)) {
      throw new HttpError(409, "Conflicto temporal al registrar el like. Inténtalo de nuevo.");
    }
    throw err;
  }
}

/**
 * Elimina un like de forma atómica e idempotente sin permitir contadores negativos.
 */
export async function quitarLikeAtomico(
  recetaId: string,
  actorKey: string,
  opciones?: OpcionesReintentoBatch,
): Promise<EstadoLikeReceta> {
  const receta = await buscarReceta(recetaId);
  if (!receta) throw new HttpError(404, "Receta no encontrada");

  try {
    await transactWriteConReintentos(
      {
        TransactItems: [
          {
            Update: {
              TableName: TABLE,
              Key: { userId: receta.userId, recetaId },
              UpdateExpression: "ADD likesCount :menosUno",
              ConditionExpression: "attribute_exists(recetaId) AND likesCount >= :uno",
              ExpressionAttributeValues: { ":menosUno": -1, ":uno": 1 },
            },
          },
          {
            Delete: {
              TableName: LIKES_TABLE,
              Key: { recetaId, actorKey },
              ConditionExpression: "attribute_exists(actorKey)",
            },
          },
        ],
      },
      opciones,
    );

    const actualizado = await buscarReceta(recetaId);
    const esperado = Math.max(0, normalizarLikesCount(receta.likesCount) - 1);
    return {
      recetaId,
      likesCount: actualizado ? normalizarLikesCount(actualizado.likesCount) : esperado,
      leDiLike: false,
    };
  } catch (err) {
    if (err instanceof TransactionCanceledException) {
      if (esCondicionFallida(err, 1)) {
        const actual = await buscarReceta(recetaId);
        if (!actual) throw new HttpError(404, "Receta no encontrada");
        return {
          recetaId,
          likesCount: normalizarLikesCount(actual.likesCount),
          leDiLike: false,
        };
      }
      if (esCondicionFallida(err, 0)) {
        const actual = await buscarReceta(recetaId);
        if (!actual) throw new HttpError(404, "Receta no encontrada");
        await borrarLikeSilencioso(recetaId, actorKey);
        return {
          recetaId,
          likesCount: normalizarLikesCount(actual.likesCount),
          leDiLike: false,
        };
      }
    }
    if (esConflictoTransaccional(err)) {
      throw new HttpError(409, "Conflicto temporal al quitar el like. Inténtalo de nuevo.");
    }
    throw err;
  }
}

/** Devuelve el subconjunto de recetaIds a los que el actor les dio like (BatchGet en lotes de 100). */
export async function consultarLikesDeActor(
  recetaIds: string[],
  actorKey: string | null,
  opciones?: OpcionesReintentoBatch,
): Promise<Set<string>> {
  if (!actorKey || recetaIds.length === 0) return new Set();
  const items = await batchGetConReintentos<Pick<LikeItem, "recetaId">>(
    LIKES_TABLE,
    recetaIds.map((recetaId) => ({ recetaId, actorKey })),
    opciones,
  );
  return new Set(items.map((item) => item.recetaId));
}

/** Elimina por lotes todos los likes pertenecientes a una receta eliminada. */
export async function eliminarLikesDeReceta(
  recetaId: string,
  opciones?: OpcionesReintentoBatch,
): Promise<number> {
  const likes = await queryPaginado<Pick<LikeItem, "recetaId" | "actorKey">>({
    TableName: LIKES_TABLE,
    KeyConditionExpression: "recetaId = :r",
    ProjectionExpression: "recetaId, actorKey",
    ExpressionAttributeValues: { ":r": recetaId },
  });
  const { eliminadosSolicitados } = await batchDeleteConReintentos(
    LIKES_TABLE,
    likes.map((item) => ({ recetaId: item.recetaId, actorKey: item.actorKey })),
    opciones,
  );
  return eliminadosSolicitados;
}

/** Registra un marcador de limpieza pendiente ante fallo parcial al borrar receta. */
export async function registrarLimpiezaPendiente(recetaId: string): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: LIKES_TABLE,
      Item: {
        recetaId,
        actorKey: LIMPIEZA_PENDIENTE_ACTOR_KEY,
        actorTipo: "ANON",
        creadaEn: new Date().toISOString(),
      },
    }),
  );
}

/**
 * Reclama en exclusiva la identidad anónima para una cuenta destinataria (targetUserId).
 * Evita que una migración incompleta transfiera likes restantes a otra cuenta distinta en el mismo dispositivo.
 */
async function reclamarBloqueoMigracion(anonKey: string, targetUserId: string): Promise<boolean> {
  try {
    await ddb.send(
      new PutCommand({
        TableName: LIKES_TABLE,
        Item: {
          recetaId: LOCK_MIGRACION_RECETA_ID,
          actorKey: anonKey,
          actorTipo: "ANON",
          targetUserId,
          creadaEn: new Date().toISOString(),
        },
        ConditionExpression: "attribute_not_exists(actorKey) OR targetUserId = :targetUserId",
        ExpressionAttributeValues: { ":targetUserId": targetUserId },
      }),
    );
    return true;
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      return false;
    }
    throw err;
  }
}

/**
 * Migra y deduplica de manera idempotente todos los likes anónimos de un visitante hacia su usuario:
 * - Bloquea la identidad anónima a la primera cuenta destinataria (previene fuga entre cuentas).
 * - Combina el GSI actorKey-index con IDs conocidos para mitigar consistencia eventual.
 * - Acota tiempo y lote para no superar el timeout de Lambda ni bloquear login/register.
 */
export async function migrarLikesAnonimos(
  visitorId: string,
  userId: string,
  opciones: OpcionesMigracionLikes = {},
): Promise<ResultadoMigracionLikes> {
  const anonKey = aActorKeyAnonimo(visitorId);
  const userKey = aActorKeyUsuario(userId);

  const resumen: ResultadoMigracionLikes = {
    migrados: 0,
    deduplicados: 0,
    huerfanosLimpiados: 0,
    bloqueadaPorOtraCuenta: false,
    parcial: false,
  };

  const lockObtenido = await reclamarBloqueoMigracion(anonKey, userId);
  if (!lockObtenido) {
    resumen.bloqueadaPorOtraCuenta = true;
    return resumen;
  }

  const itemsIndice = await queryPaginado<Pick<LikeItem, "recetaId" | "actorKey">>({
    TableName: LIKES_TABLE,
    IndexName: INDICE_ACTOR_KEY,
    KeyConditionExpression: "actorKey = :a",
    ExpressionAttributeValues: { ":a": anonKey },
  });

  const recetaIdsPendientes = new Set<string>();
  for (const item of itemsIndice) {
    if (item.recetaId !== LOCK_MIGRACION_RECETA_ID) {
      recetaIdsPendientes.add(item.recetaId);
    }
  }
  for (const idConocido of opciones.recetaIdsConocidas ?? []) {
    if (idConocido !== LOCK_MIGRACION_RECETA_ID) {
      recetaIdsPendientes.add(idConocido);
    }
  }

  const ids = [...recetaIdsPendientes];
  const maxItems = opciones.maxItems ?? 50;
  const tiempoLimite = Date.now() + (opciones.tiempoMaximoMs ?? 2500);

  let procesados = 0;
  for (const recetaId of ids) {
    if (procesados >= maxItems || Date.now() > tiempoLimite) {
      resumen.parcial = true;
      break;
    }
    procesados += 1;

    const receta = await buscarReceta(recetaId);
    if (!receta) {
      await borrarLikeSilencioso(recetaId, anonKey);
      resumen.huerfanosLimpiados += 1;
      continue;
    }

    const ahora = new Date().toISOString();
    try {
      await transactWriteConReintentos(
        {
          TransactItems: [
            {
              ConditionCheck: {
                TableName: TABLE,
                Key: { userId: receta.userId, recetaId },
                ConditionExpression: "attribute_exists(recetaId)",
              },
            },
            {
              Put: {
                TableName: LIKES_TABLE,
                Item: {
                  recetaId,
                  actorKey: userKey,
                  actorTipo: "USER",
                  creadaEn: ahora,
                } satisfies LikeItem,
                ConditionExpression: "attribute_not_exists(actorKey)",
              },
            },
            {
              Delete: {
                TableName: LIKES_TABLE,
                Key: { recetaId, actorKey: anonKey },
                ConditionExpression: "attribute_exists(actorKey)",
              },
            },
          ],
        },
        opciones,
      );
      resumen.migrados += 1;
    } catch (err) {
      if (!(err instanceof TransactionCanceledException)) throw err;

      if (esCondicionFallida(err, 0)) {
        await borrarLikeSilencioso(recetaId, anonKey);
        resumen.huerfanosLimpiados += 1;
        continue;
      }

      if (esCondicionFallida(err, 1)) {
        await deduplicarLikeEnTransaccion(receta.userId, recetaId, anonKey, opciones);
        resumen.deduplicados += 1;
        continue;
      }

      if (esCondicionFallida(err, 2)) {
        // El like ANON# no existía (p. ej. hint ya migrado anteriormente o removido concurrentemente).
        continue;
      }

      throw err;
    }
  }

  return resumen;
}

async function deduplicarLikeEnTransaccion(
  recetaUserId: string,
  recetaId: string,
  anonKey: string,
  opciones?: OpcionesReintentoBatch,
): Promise<void> {
  try {
    await transactWriteConReintentos(
      {
        TransactItems: [
          {
            Update: {
              TableName: TABLE,
              Key: { userId: recetaUserId, recetaId },
              UpdateExpression: "ADD likesCount :menosUno",
              ConditionExpression: "attribute_exists(recetaId) AND likesCount >= :uno",
              ExpressionAttributeValues: { ":menosUno": -1, ":uno": 1 },
            },
          },
          {
            Delete: {
              TableName: LIKES_TABLE,
              Key: { recetaId, actorKey: anonKey },
              ConditionExpression: "attribute_exists(actorKey)",
            },
          },
        ],
      },
      opciones,
    );
  } catch (err) {
    if (err instanceof TransactionCanceledException) {
      if (esCondicionFallida(err, 1)) return;
      if (esCondicionFallida(err, 0)) {
        await borrarLikeSilencioso(recetaId, anonKey);
        return;
      }
    }
    throw err;
  }
}

/**
 * Ejecuta la migración en modo tolerante a fallos para login/register:
 * - Solo debe invocarse con un visitorId verificado por firma del servidor (X-Visitor-Token).
 * - Si falla algún paso, el bloqueo de cuenta destinataria permanece y no bloquea la autenticación.
 */
export async function migrarLikesAnonimosSeguro(
  visitorId: string | null,
  userId: string,
  opciones?: OpcionesMigracionLikes,
): Promise<ResultadoMigracionLikes | null> {
  if (!visitorId) return null;
  try {
    return await migrarLikesAnonimos(visitorId, userId, opciones);
  } catch (err) {
    console.error("Error al migrar likes anónimos (autenticación preservada):", err);
    return null;
  }
}
