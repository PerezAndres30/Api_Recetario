import { QueryCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, TABLE } from "../lib/clients";
import { getUserId, getUserIdOpcional, json, withErrors } from "../lib/http";
import { aRespuesta, type Receta } from "../lib/schema";

// GET /recetas?categoria=postre&q=pastel          (público: recetas de todos)
// GET /recetas?mias=true&favorita=true             (exige token: solo las del usuario)
export const handler = withErrors(async (event) => {
  const { categoria, favorita, q, mias } = event.queryStringParameters ?? {};
  const soloMias = mias === "true";
  // "Mis recetas" exige sesión; el catálogo público acepta visitantes (token opcional).
  const userId = soloMias ? getUserId(event) : getUserIdOpcional(event);

  const filtros: string[] = [];
  const valores: Record<string, unknown> = {};
  if (categoria) {
    filtros.push("categoria = :c");
    valores[":c"] = categoria;
  }
  // "Favorita" es una marca personal del creador: solo tiene sentido en "Mis recetas".
  if (soloMias && favorita === "true") {
    filtros.push("favorita = :f");
    valores[":f"] = true;
  }
  if (q?.trim()) {
    filtros.push("contains(tituloBusqueda, :q)");
    valores[":q"] = q.trim().toLowerCase();
  }
  const FilterExpression = filtros.length ? filtros.join(" AND ") : undefined;

  // Se recorren todas las páginas: el proyecto maneja pocas recetas.
  const items: Receta[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const r = soloMias
      ? await ddb.send(
          new QueryCommand({
            TableName: TABLE,
            KeyConditionExpression: "userId = :u",
            FilterExpression,
            ExpressionAttributeValues: { ...valores, ":u": userId },
            ExclusiveStartKey: lastKey,
          }),
        )
      : await ddb.send(
          new ScanCommand({
            TableName: TABLE,
            FilterExpression,
            ExpressionAttributeValues: FilterExpression ? valores : undefined,
            ExclusiveStartKey: lastKey,
          }),
        );
    items.push(...((r.Items ?? []) as Receta[]));
    lastKey = r.LastEvaluatedKey;
  } while (lastKey);

  items.sort((a, b) => b.actualizadaEn.localeCompare(a.actualizadaEn));
  return json(200, { recetas: items.map((i) => aRespuesta(i, userId)) });
});
