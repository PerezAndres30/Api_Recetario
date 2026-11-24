import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { firmar, firmaSubida, publicIdDe, validarImagen } from "../src/lib/cloudinary";
import { ID_A, ID_B } from "./ayudas";

beforeEach(() => {
  process.env.CLOUDINARY_CLOUD_NAME = "demo";
  process.env.CLOUDINARY_API_KEY = "clave-publica";
  process.env.CLOUDINARY_API_SECRET = "secreto";
});

describe("firma de subida", () => {
  it("firma los parámetros ordenados con el secreto al final (SHA-1)", () => {
    const esperado = createHash("sha1")
      .update("invalidate=true&overwrite=true&public_id=abc&timestamp=100secreto")
      .digest("hex");
    expect(firmar({ timestamp: "100", public_id: "abc", overwrite: "true", invalidate: "true" }, "secreto")).toBe(esperado);
  });

  it("usa el identificador fijo de la receta y no expone el secreto", () => {
    const f = firmaSubida(ID_A, 1700000000);
    expect(f.publicId).toBe(`recetario/recetas/${ID_A}`);
    expect(f.timestamp).toBe(1700000000);
    expect(f.cloudName).toBe("demo");
    expect(f.uploadUrl).toBe("https://api.cloudinary.com/v1_1/demo/image/upload");
    expect(JSON.stringify(f)).not.toContain("secreto");
    const esperada = firmar(
      { allowed_formats: "jpg,png,webp", invalidate: "true", overwrite: "true", public_id: f.publicId, timestamp: "1700000000" },
      "secreto",
    );
    expect(f.signature).toBe(esperada);
  });
});

describe("validarImagen", () => {
  const url = (id: string, ext = "jpg", cuenta = "demo") =>
    `https://res.cloudinary.com/${cuenta}/image/upload/v123/${publicIdDe(id)}.${ext}`;

  it("acepta la foto subida con el identificador de esa receta", () => {
    expect(() => validarImagen(ID_A, url(ID_A), publicIdDe(ID_A))).not.toThrow();
    expect(() => validarImagen(ID_A, url(ID_A, "png"), publicIdDe(ID_A))).not.toThrow();
  });

  it("rechaza el identificador de otra receta", () => {
    expect(() => validarImagen(ID_A, url(ID_B), publicIdDe(ID_B))).toThrow("imagenPublicId inválido");
  });

  it("rechaza URLs de otra cuenta, otro formato u otro sitio", () => {
    expect(() => validarImagen(ID_A, url(ID_A, "jpg", "ajena"), publicIdDe(ID_A))).toThrow("imagenUrl inválida");
    expect(() => validarImagen(ID_A, url(ID_A, "gif"), publicIdDe(ID_A))).toThrow("imagenUrl inválida");
    expect(() => validarImagen(ID_A, "https://malo.com/x.jpg", publicIdDe(ID_A))).toThrow("imagenUrl inválida");
  });
});
