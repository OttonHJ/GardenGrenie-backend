/*
 * ¿Qué es este archivo?
 * ---------------------
 * Este es el servidor backend. Funciona como un intermediario entre la app
 * (GardenGenie) y la API externa de plant.id.
 *
 * ¿Por qué necesitamos un backend?
 * ---------------------------------
 * La API key de plant.id es secreta — no puede ir en el código del app porque
 * cualquiera podría extraerla del APK. El backend la guarda en el servidor
 * y la app solo habla con nuestro backend.
 *
 * Flujo:
 *   App → [imagen en base64] → Nuestro backend → [imagen + API key] → plant.id
 *   App ← [nombre, confianza] ← Nuestro backend ← [resultado]       ← plant.id
 */

// "require" es como el "import" de React Native pero para Node.js
const express = require("express"); // Framework que facilita crear servidores HTTP
const cors = require("cors"); // Permite que la app llame a este servidor sin errores de seguridad

// Lee las variables de entorno del archivo .env (solo en desarrollo local)
// En Render, las variables se configuran desde el dashboard web
require("dotenv").config();

// Crea la aplicación Express — es el servidor en sí
const app = express();

// Puerto donde va a escuchar el servidor.
// process.env.PORT lo asigna Render automáticamente; 3000 es para desarrollo local.
const PORT = process.env.PORT || 3000;

// ─── Middlewares ───────────────────────────────────────────────────────────────
// Los middlewares son funciones que procesan cada request antes de llegar a las rutas.

// cors() — le dice al servidor que acepte requests desde cualquier origen (la app)
app.use(cors());

// express.json() — convierte el body del request de texto JSON a objeto JavaScript
// limit: "10mb" porque las imágenes en base64 pueden ser grandes
app.use(express.json({ limit: "10mb" }));

// ─── Rutas (Endpoints) ────────────────────────────────────────────────────────
// Una "ruta" es una URL que el servidor escucha. Cuando la app llama a esa URL,
// el servidor ejecuta la función correspondiente y devuelve una respuesta.

/*
 * GET /health
 * -----------
 * Render necesita un endpoint de "health check" para saber si el servidor
 * está vivo. Si este endpoint responde, Render sabe que el deploy funcionó.
 *
 * La app NO usa este endpoint — es solo para Render.
 */
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

/*
 * POST /identify
 * --------------
 * Este es el endpoint principal. La app envía una imagen y recibe la
 * identificación de la planta.
 *
 * Request (lo que la app envía):
 *   { "image": "data:image/jpeg;base64,/9j/4AAQ..." }
 *
 * Response (lo que este servidor devuelve):
 *   {
 *     "name": "Monstera deliciosa",
 *     "commonName": "Costilla de Adán",
 *     "probability": 0.94,           // confianza 0–1 (94%)
 *     "taxonomy": { "family": "..." },
 *     "watering": "...",
 *     "careLevel": "...",
 *     "wikipediaUrl": "..."
 *   }
 */
app.post("/identify", async (req, res) => {
  // Extrae la imagen del body del request
  const { image } = req.body;

  // Validación básica — si no vino imagen, responde con error 400 (Bad Request)
  if (!image) {
    return res.status(400).json({ error: "Se requiere una imagen" });
  }

  // Verifica que la API key esté configurada en las variables de entorno
  if (!process.env.PLANT_ID_API_KEY) {
    return res.status(500).json({ error: "API key no configurada en el servidor" });
  }

  try {
    /*
     * Llama a la API de plant.id v3.
     * "fetch" hace un request HTTP — es como cuando el app llama a Firebase,
     * pero aquí lo hace el servidor en lugar del app.
     */
    /*
     * En plant.id v3 los "details" y el idioma van como query params en la URL,
     * NO en el body del request (a diferencia de v2).
     */
    const DETAILS = "common_names,taxonomy,watering,best_watering,care_level,type,description,wikipedia_url";

    const plantIdUrl = `https://plant.id/api/v3/identification?details=${DETAILS}&language=es`;

    const plantIdResponse = await fetch(plantIdUrl, {
      method: "POST",
      headers: {
        "Api-Key": process.env.PLANT_ID_API_KEY, // La API key secreta va aquí
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        // Plant.id espera base64 puro, sin el prefijo "data:image/jpeg;base64,"
        // Si la imagen viene con ese prefijo lo removemos
        images: [image.replace(/^data:image\/\w+;base64,/, "")],
      }),
    });

    // Si plant.id devolvió un error (ej: API key inválida, límite de créditos)
    if (!plantIdResponse.ok) {
      const errorText = await plantIdResponse.text();
      console.error("[plant.id error]", plantIdResponse.status, errorText);
      return res.status(plantIdResponse.status).json({
        error: "Error al consultar plant.id",
        details: errorText,
      });
    }

    // Convierte la respuesta de plant.id a objeto JavaScript
    const plantIdData = await plantIdResponse.json();

    /*
     * La respuesta de plant.id tiene mucha info. Extraemos solo lo relevante
     * para el formulario de GardenGenie, simplificando el objeto para el app.
     */
    const suggestions = plantIdData.result?.classification?.suggestions ?? [];

    // Si no se identificó ninguna planta
    if (suggestions.length === 0) {
      return res.json({
        identified: false,
        message: "No se pudo identificar la planta",
      });
    }

    // Toma la sugerencia con mayor confianza (viene ordenada de mayor a menor)
    const best = suggestions[0];
    const details = best.details ?? {};
    console.log("[plant.id details]", JSON.stringify(details, null, 2));


    // Devuelve al app solo los campos que necesita para llenar el formulario
    res.json({
      identified: true,
      name: best.name ?? "",                                    // Nombre científico
      commonName: details.common_names?.[0] ?? "",              // Primer nombre común
      probability: best.probability ?? 0,                       // Confianza 0–1
      taxonomy: {
        family: details.taxonomy?.family ?? "",
        genus: details.taxonomy?.genus ?? "",
      },
description: details.description?.value ?? "Planta de prueba - descripcion temporal",
      watering: details.watering ?? details.best_watering ?? "",
      careLevel: details.care_level ?? "",
      type: details.type ?? "",
      wikipediaUrl: details.wikipedia_url ?? "",
      // Todas las sugerencias por si el usuario quiere elegir otra
      allSuggestions: suggestions.slice(0, 3).map((s) => ({
        name: s.name,
        commonName: s.details?.common_names?.[0] ?? "",
        probability: s.probability,
      })),
    });
  } catch (error) {
    // Error inesperado (ej: sin conexión a internet en el servidor)
    console.error("[/identify error]", error);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

// ─── Inicia el servidor ────────────────────────────────────────────────────────
// app.listen() hace que el servidor empiece a escuchar requests en el puerto indicado
app.listen(PORT, () => {
  console.log(`Servidor GardenGenie corriendo en http://localhost:${PORT}`);
  console.log(`API key configurada: ${process.env.PLANT_ID_API_KEY ? "✓" : "✗ FALTA"}`);
});
