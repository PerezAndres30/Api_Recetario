import { randomUUID } from "node:crypto";
import { firmarVisitorToken, HttpError, json, withErrors } from "../lib/http";

// POST /visitante/sesion  (público; emite un identificador anónimo generado exclusivamente por el servidor y firmado)
export const handler = withErrors(async (event) => {
  if (event.body && event.body.trim().length > 0) {
    let raw: unknown;
    try {
      const texto = event.isBase64Encoded
        ? Buffer.from(event.body, "base64").toString("utf8")
        : event.body;
      raw = JSON.parse(texto);
    } catch {
      throw new HttpError(400, "El cuerpo no es un JSON válido");
    }
    if (
      raw &&
      typeof raw === "object" &&
      ("visitorId" in raw || "visitorToken" in raw)
    ) {
      throw new HttpError(400, "No se permite solicitar firma de un identificador enviado por el cliente");
    }
  }

  const visitorId = randomUUID();
  const visitorToken = firmarVisitorToken(visitorId);

  return json(201, {
    visitorId,
    visitorToken,
  });
});
