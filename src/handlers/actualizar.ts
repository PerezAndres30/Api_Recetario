import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, TABLE } from "../lib/clients";
import { getRecetaId, getUserId, HttpError, json, parseBody, withErrors } from "../lib/http";
import { aRespuesta, recetaInput, type Receta } from "../lib/schema";

// PUT /recetas/{id}  (reemplaza los campos editables de la receta)
export const handler = withErrors(async (event) => {
  const userId = getUserId(event);
  const recetaId = getRecetaId(event);
  const body = parseBody(event, recetaInput);

  const r = await ddb.send(new GetCommand({ TableName: TABLE, Key: { userId, recetaId } }));
  const actual = r.Item as Receta | undefined;
  if (!actual) throw new HttpError(404, "Receta no encontrada");

  const nueva: Receta = {
    ...body,
    userId,
    recetaId,
    tituloBusqueda: body.titulo.toLowerCase(),
    creadaEn: actual.creadaEn,
    actualizadaEn: new Date().toISOString(),
  };

  try {
    await ddb.send(
      new PutCommand({
        TableName: TABLE,
        Item: nueva,
        ConditionExpression: "attribute_exists(recetaId)",
      }),
    );
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      throw new HttpError(404, "Receta no encontrada");
    }
    throw err;
  }

  return json(200, aRespuesta(nueva));
});
