import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, USUARIOS_TABLE } from "../lib/clients";
import { getVisitorTokenVerificado, HttpError, json, parseBody, withErrors } from "../lib/http";
import { migrarLikesAnonimosSeguro } from "../lib/likes";
import { verificarPassword } from "../lib/password";
import { loginInput } from "../lib/schema";
import { aSesion, type UsuarioGuardado } from "../lib/sesion";

// POST /login  (público; solo migra likes anónimos si se presenta un X-Visitor-Token firmado por el servidor)
export const handler = withErrors(async (event) => {
  const { correo, password } = parseBody(event, loginInput);

  const r = await ddb.send(new GetCommand({ TableName: USUARIOS_TABLE, Key: { correo } }));
  const usuario = r.Item as UsuarioGuardado | undefined;

  // Mismo mensaje si no existe el correo o si la contraseña es incorrecta.
  if (!usuario || !(await verificarPassword(password, usuario.passwordHash))) {
    throw new HttpError(401, "Correo o contraseña incorrectos");
  }

  // Nunca aceptar X-Visitor-Id UUID sin firma del servidor para transferir likes de otra instalación.
  const visitorIdVerificado = getVisitorTokenVerificado(event);
  const resultadoMigracion = visitorIdVerificado
    ? await migrarLikesAnonimosSeguro(visitorIdVerificado, usuario.usuarioId)
    : null;

  return json(
    200,
    aSesion(usuario, {
      intento: visitorIdVerificado !== null,
      resultado: resultadoMigracion,
    }),
  );
});
