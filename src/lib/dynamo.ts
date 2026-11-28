import {
  TransactionCanceledException,
} from "@aws-sdk/client-dynamodb";
import {
  BatchGetCommand,
  BatchWriteCommand,
  QueryCommand,
  TransactWriteCommand,
  type QueryCommandInput,
  type TransactWriteCommandInput,
} from "@aws-sdk/lib-dynamodb";
import { ddb } from "./clients";

export type DynamoKey = Record<string, string>;

export interface OpcionesReintentoBatch {
  maxIntentos?: number;
  esperarMs?: (intento: number) => Promise<void>;
}

const esperaExponencial = (intento: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, Math.min(250, 25 * 2 ** intento)));

const CODIGOS_CONFLICTO_TRANSITORIO = new Set([
  "TransactionConflict",
  "ProvisionedThroughputExceeded",
  "RequestLimitExceeded",
]);

function esErrorTransitorioTransaccion(err: unknown): boolean {
  if (err instanceof TransactionCanceledException) {
    const razones = err.CancellationReasons ?? [];
    // Nunca reintentar si alguna razón es fallo condicional de negocio o validación.
    if (razones.some((r) => r.Code === "ConditionalCheckFailed" || r.Code === "ValidationError")) {
      return false;
    }
    return razones.some((r) => Boolean(r.Code && CODIGOS_CONFLICTO_TRANSITORIO.has(r.Code)));
  }
  const nombre = (err as { name?: string } | null)?.name;
  return (
    nombre === "TransactionConflictException" ||
    nombre === "ProvisionedThroughputExceededException" ||
    nombre === "ThrottlingException"
  );
}

/**
 * Ejecuta TransactWriteCommand con reintentos acotados únicamente ante conflictos
 * transitorios de concurrencia (TransactionConflict / Throttling).
 * Las cancelaciones por ConditionExpression fallida se propagan de inmediato.
 */
export async function transactWriteConReintentos(
  input: TransactWriteCommandInput,
  opciones: OpcionesReintentoBatch = {},
): Promise<void> {
  const maxIntentos = opciones.maxIntentos ?? 3;
  const esperarMs = opciones.esperarMs ?? esperaExponencial;
  let intento = 0;

  while (true) {
    try {
      await ddb.send(new TransactWriteCommand(input));
      return;
    } catch (err) {
      if (!esErrorTransitorioTransaccion(err) || intento >= maxIntentos) {
        throw err;
      }
      await esperarMs(intento);
      intento += 1;
    }
  }
}

function deduplicarClaves(claves: DynamoKey[]): DynamoKey[] {
  const vistas = new Set<string>();
  const unicas: DynamoKey[] = [];
  for (const clave of claves) {
    const firma = JSON.stringify(
      Object.keys(clave)
        .sort()
        .map((k) => [k, clave[k]]),
    );
    if (!vistas.has(firma)) {
      vistas.add(firma);
      unicas.push(clave);
    }
  }
  return unicas;
}

function dividirEnLotes<T>(items: T[], tamano: number): T[][] {
  const lotes: T[][] = [];
  for (let i = 0; i < items.length; i += tamano) {
    lotes.push(items.slice(i, i + tamano));
  }
  return lotes;
}

/** Ejecuta un Query paginado completo recorriendo LastEvaluatedKey. */
export async function queryPaginado<T>(input: QueryCommandInput): Promise<T[]> {
  const acumulados: T[] = [];
  let exclusiveStartKey = input.ExclusiveStartKey;
  do {
    const res = await ddb.send(new QueryCommand({ ...input, ExclusiveStartKey: exclusiveStartKey }));
    if (res.Items?.length) {
      acumulados.push(...(res.Items as T[]));
    }
    exclusiveStartKey = res.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return acumulados;
}

/**
 * Ejecuta BatchGet en lotes de hasta 100 claves, deduplicando entradas repetidas
 * y reintentando cualquier UnprocessedKeys devuelta por DynamoDB.
 */
export async function batchGetConReintentos<T>(
  tableName: string,
  claves: DynamoKey[],
  opciones: OpcionesReintentoBatch = {},
): Promise<T[]> {
  const unicas = deduplicarClaves(claves);
  if (unicas.length === 0) return [];

  const maxIntentos = opciones.maxIntentos ?? 5;
  const esperarMs = opciones.esperarMs ?? esperaExponencial;
  const resultados: T[] = [];

  for (const lote of dividirEnLotes(unicas, 100)) {
    let pendientes: DynamoKey[] = lote;
    let intento = 0;

    while (pendientes.length > 0) {
      const res = await ddb.send(
        new BatchGetCommand({
          RequestItems: {
            [tableName]: { Keys: pendientes },
          },
        }),
      );
      const encontrados = res.Responses?.[tableName];
      if (encontrados?.length) {
        resultados.push(...(encontrados as T[]));
      }

      const sinProcesar = (res.UnprocessedKeys?.[tableName]?.Keys ?? []) as DynamoKey[];
      if (sinProcesar.length === 0) break;

      if (intento >= maxIntentos) {
        throw new Error(
          `BatchGet agotó ${maxIntentos} reintentos en ${tableName} con ${sinProcesar.length} claves pendientes`,
        );
      }
      await esperarMs(intento);
      intento += 1;
      pendientes = sinProcesar;
    }
  }

  return resultados;
}

/**
 * Elimina múltiples claves mediante BatchWrite en lotes de hasta 25 elementos,
 * reintentando UnprocessedItems hasta vaciarlas o reportar error controlado.
 */
export async function batchDeleteConReintentos(
  tableName: string,
  claves: DynamoKey[],
  opciones: OpcionesReintentoBatch = {},
): Promise<{ eliminadosSolicitados: number }> {
  const unicas = deduplicarClaves(claves);
  if (unicas.length === 0) return { eliminadosSolicitados: 0 };

  const maxIntentos = opciones.maxIntentos ?? 5;
  const esperarMs = opciones.esperarMs ?? esperaExponencial;

  for (const lote of dividirEnLotes(unicas, 25)) {
    let solicitudes = lote.map((Key) => ({ DeleteRequest: { Key } }));
    let intento = 0;

    while (solicitudes.length > 0) {
      const res = await ddb.send(
        new BatchWriteCommand({
          RequestItems: {
            [tableName]: solicitudes,
          },
        }),
      );

      const sinProcesar = res.UnprocessedItems?.[tableName] ?? [];
      if (sinProcesar.length === 0) break;

      if (intento >= maxIntentos) {
        throw new Error(
          `BatchWrite agotó ${maxIntentos} reintentos en ${tableName} con ${sinProcesar.length} elementos pendientes`,
        );
      }
      await esperarMs(intento);
      intento += 1;
      solicitudes = sinProcesar
        .filter((item): item is { DeleteRequest: { Key: DynamoKey } } => Boolean(item.DeleteRequest?.Key));
    }
  }

  return { eliminadosSolicitados: unicas.length };
}
