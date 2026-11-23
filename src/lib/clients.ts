import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

// Se crea fuera del handler para reutilizarlo entre invocaciones (warm starts).
export const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

export const TABLE = process.env.TABLE_NAME as string; // recetas
export const USUARIOS_TABLE = process.env.USUARIOS_TABLE as string;
