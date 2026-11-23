import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, TABLE } from "../lib/clients";
import { getUserId, json, withErrors } from "../lib/http";
import { aRespuesta, type Receta } from "../lib/schema";

// GET /recetas?categoria=postre&favorita=true&q=pastel
export const handler = withErrors(async (event) => {
  const userId = getUserId(event);
  const { categoria, favorita, q } = event.queryStringParameters ?? {};

  const filtros: string[] = [];
  const valores: Record<string, unknown> = { ":u": userId };
  if (categoria) {
    filtros.push("categoria = :c");
    valores[":c"] = categoria;
  }
  if (favorita === "true") {
    filtros.push("favorita = :f");
    valores[":f"] = true;
  }
  if (q?.trim()) {
    filtros.push("contains(tituloBusqueda, :q)");
    valores[":q"] = q.trim().toLowerCase();
  }

  // Un usuario tiene pocas recetas, así que se recorren todas las páginas.
  const items: Receta[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const r = await ddb.send(
      new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: "userId = :u",
        FilterExpression: filtros.length ? filtros.join(" AND ") : undefined,
        ExpressionAttributeValues: valores,
        ExclusiveStartKey: lastKey,
      }),
    );
    items.push(...((r.Items ?? []) as Receta[]));
    lastKey = r.LastEvaluatedKey;
  } while (lastKey);

  items.sort((a, b) => b.actualizadaEn.localeCompare(a.actualizadaEn));
  return json(200, { recetas: items.map(aRespuesta) });
});
