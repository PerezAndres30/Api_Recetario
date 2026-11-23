import { randomUUID } from "node:crypto";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, TABLE } from "../lib/clients";
import { getUserId, HttpError, json, parseBody, withErrors } from "../lib/http";
import { aRespuesta, crearInput, type Receta } from "../lib/schema";

// POST /recetas
export const handler = withErrors(async (event) => {
  const userId = getUserId(event);
  const { recetaId, ...datos } = parseBody(event, crearInput);

  const ahora = new Date().toISOString();
  const receta: Receta = {
    ...datos,
    userId,
    recetaId: recetaId ?? randomUUID(),
    tituloBusqueda: datos.titulo.toLowerCase(),
    creadaEn: ahora,
    actualizadaEn: ahora,
  };

  try {
    await ddb.send(
      new PutCommand({
        TableName: TABLE,
        Item: receta,
        ConditionExpression: "attribute_not_exists(recetaId)",
      }),
    );
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      throw new HttpError(409, "Ya existe una receta con ese id");
    }
    throw err;
  }

  return json(201, aRespuesta(receta));
});
