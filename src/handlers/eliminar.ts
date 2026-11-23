import { DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, TABLE } from "../lib/clients";
import { getRecetaId, getUserId, HttpError, json, withErrors } from "../lib/http";

// DELETE /recetas/{id}
export const handler = withErrors(async (event) => {
  const userId = getUserId(event);
  const recetaId = getRecetaId(event);

  const r = await ddb.send(
    new DeleteCommand({
      TableName: TABLE,
      Key: { userId, recetaId },
      ReturnValues: "ALL_OLD",
    }),
  );
  if (!r.Attributes) throw new HttpError(404, "Receta no encontrada");

  return json(204);
});
