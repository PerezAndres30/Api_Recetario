import { randomUUID } from "node:crypto";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, USUARIOS_TABLE } from "../lib/clients";
import { getVisitorTokenVerificado, HttpError, json, parseBody, withErrors } from "../lib/http";
import { migrarLikesAnonimosSeguro } from "../lib/likes";
import { hashPassword } from "../lib/password";
import { registroInput } from "../lib/schema";
import { aSesion, type UsuarioGuardado } from "../lib/sesion";

// POST /register  (público; solo migra likes anónimos con X-Visitor-Token firmado por el servidor)
export const handler = withErrors(async (event) => {
  const { nombre, correo, password } = parseBody(event, registroInput);

  const usuario: UsuarioGuardado = {
    correo,
    usuarioId: randomUUID(),
    nombre,
    passwordHash: await hashPassword(password),
    creadaEn: new Date().toISOString(),
  };

  try {
    await ddb.send(
      new PutCommand({
        TableName: USUARIOS_TABLE,
        Item: usuario,
        ConditionExpression: "attribute_not_exists(correo)", // el correo es único
      }),
    );
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      throw new HttpError(409, "Ya existe una cuenta con ese correo");
    }
    throw err;
  }

  const visitorIdVerificado = getVisitorTokenVerificado(event);
  const resultadoMigracion = visitorIdVerificado
    ? await migrarLikesAnonimosSeguro(visitorIdVerificado, usuario.usuarioId)
    : null;

  return json(
    201,
    aSesion(usuario, {
      intento: visitorIdVerificado !== null,
      resultado: resultadoMigracion,
    }),
  );
});
