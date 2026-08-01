import { Auth } from "@/auth"
import { AppRuntime } from "@/effect/app-runtime"
import { Log } from "@/util"
import { Effect } from "effect"
import { ProviderID } from "@/provider/schema"
import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { errors } from "../../error"

/** The generated OpenAPI document, built once on first request (the route table is fixed at
 *  startup). */
let SPEC: unknown

export function ControlPlaneRoutes(): Hono {
  const app = new Hono()
  return app
    .put(
      "/auth/:providerID",
      describeRoute({
        summary: "Set auth credentials",
        description: "Set authentication credentials",
        operationId: "auth.set",
        responses: {
          200: {
            description: "Successfully set authentication credentials",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "param",
        z.object({
          providerID: ProviderID.zod,
        }),
      ),
      validator("json", Auth.Info.zod),
      async (c) => {
        const providerID = c.req.valid("param").providerID
        const info = c.req.valid("json")
        await AppRuntime.runPromise(
          Effect.gen(function* () {
            const auth = yield* Auth.Service
            yield* auth.set(providerID, info)
          }),
        )
        return c.json(true)
      },
    )
    .delete(
      "/auth/:providerID",
      describeRoute({
        summary: "Remove auth credentials",
        description: "Remove authentication credentials",
        operationId: "auth.remove",
        responses: {
          200: {
            description: "Successfully removed authentication credentials",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "param",
        z.object({
          providerID: ProviderID.zod,
        }),
      ),
      async (c) => {
        const providerID = c.req.valid("param").providerID
        await AppRuntime.runPromise(
          Effect.gen(function* () {
            const auth = yield* Auth.Service
            yield* auth.remove(providerID)
          }),
        )
        return c.json(true)
      },
    )
    .get(
      "/doc",
      // DESCRIBE THE SERVER, NOT THIS ROUTER.
      //
      // MEASURED 2026-08-01: `curl /doc` returned 3338 bytes describing exactly TWO paths —
      // DELETE/PUT /auth/{providerID} and POST /log — while roughly 150 real routes (38 global, 21
      // instance/index, 32 session, 11 experimental, …) were absent. The cause is the argument on the
      // line this replaces: `app` here is ControlPlaneRoutes' OWN Hono, so the document faithfully
      // described the router it was handed and nothing else. Both routes it did list are control-plane
      // routes, which is the tell.
      //
      // `openapi()` in server.ts builds a fresh app with every route registered directly, precisely so
      // the describeRoute metadata survives; called directly it yields 133 paths. It is imported
      // dynamically because server.ts mounts this router — a static import would be a cycle — and the
      // result is cached, since the route table cannot change while the process runs.
      async (c) => {
        if (!SPEC) {
          const { openapi } = await import("../../server")
          SPEC = await openapi()
        }
        return c.json(SPEC as Record<string, unknown>)
      },
    )
    .use(
      validator(
        "query",
        z.object({
          directory: z.string().optional(),
          workspace: z.string().optional(),
        }),
      ),
    )
    .post(
      "/log",
      describeRoute({
        summary: "Write log",
        description: "Write a log entry to the server logs with specified level and metadata.",
        operationId: "app.log",
        responses: {
          200: {
            description: "Log entry written successfully",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "json",
        z.object({
          service: z.string().meta({ description: "Service name for the log entry" }),
          level: z.enum(["debug", "info", "error", "warn"]).meta({ description: "Log level" }),
          message: z.string().meta({ description: "Log message" }),
          extra: z
            .record(z.string(), z.any())
            .optional()
            .meta({ description: "Additional metadata for the log entry" }),
        }),
      ),
      async (c) => {
        const { service, level, message, extra } = c.req.valid("json")
        const logger = Log.create({ service })

        switch (level) {
          case "debug":
            logger.debug(message, extra)
            break
          case "info":
            logger.info(message, extra)
            break
          case "error":
            logger.error(message, extra)
            break
          case "warn":
            logger.warn(message, extra)
            break
        }

        return c.json(true)
      },
    )
}
