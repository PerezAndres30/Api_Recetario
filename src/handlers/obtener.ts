import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, TABLE } from "../lib/clients";
import { getRecetaId, getUserId, HttpError, json, withErrors } from "../lib/http";
import { aRespuesta, type Receta } from "../lib/schema";

// GET /recetas/{id}
export const handler = withErrors(async (event) => {
  const userId = getUserId(event);
  const recetaId = getRecetaId(event);

  const r = await ddb.send(new GetCommand({ TableName: TABLE, Key: { userId, recetaId } }));
  if (!r.Item) throw new HttpError(404, "Receta no encontrada");

  return json(200, aRespuesta(r.Item as Receta));
});
