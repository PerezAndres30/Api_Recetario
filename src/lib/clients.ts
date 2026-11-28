import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

// Se crea fuera del handler para reutilizarlo entre invocaciones (warm starts).
export const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

export const TABLE = process.env.TABLE_NAME as string; // recetas
export const USUARIOS_TABLE = process.env.USUARIOS_TABLE as string;
export const LIKES_TABLE = process.env.LIKES_TABLE as string;
export const FAVORITOS_TABLE = process.env.FAVORITOS_TABLE as string;

/** Índice secundario de la tabla de recetas y favoritos: relaciona por recetaId. */
export const INDICE_RECETA_ID = "recetaId-index";

/** Índice secundario de la tabla de likes: permite consultar todos los likes de un actor. */
export const INDICE_ACTOR_KEY = "actorKey-index";
