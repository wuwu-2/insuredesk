import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import fastifyCookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import { loginBodySchema } from "@insuredesk/shared";
import fastifyApiReference from "@scalar/fastify-api-reference";
import { type FastifyTRPCPluginOptions, fastifyTRPCPlugin } from "@trpc/server/adapters/fastify";
import Fastify, { type FastifyInstance, LogController } from "fastify";
import { prisma } from "./db.ts";
import type { Env } from "./env.ts";
import { type AppRouter, appRouter } from "./routers/index.ts";
import { registerExternalTicketExportRoute } from "./routes/external-ticket-export.route.ts";
import { registerJbInsurancePushRoute } from "./routes/jb-insurance-push.route.ts";
import { registerOpenApi } from "./routes/open-api/app.ts";
import { registerTicketExportRoute } from "./routes/ticket-export.route.ts";
import { registerTicketImportRoute } from "./routes/ticket-import.route.ts";
import { registerTicketImportTemplateRoute } from "./routes/ticket-import-template.route.ts";
import { PasswordAuthProvider, SessionService, toSessionToken } from "./services/auth.service.ts";
import { createContext } from "./trpc.ts";

export interface BuildServerOptions {
  loggerStream?: import("pino").DestinationStream;
}

export function buildLoggerOptions(env: Env, options?: BuildServerOptions) {
  return {
    level: env.LOG_LEVEL,
    redact: ["req.headers.authorization"],
    ...(options?.loggerStream ? { stream: options.loggerStream } : {}),
    ...(env.NODE_ENV === "development"
      ? {
          transport: {
            target: "pino-pretty",
            options: { colorize: true, translateTime: "SYS:standard", ignore: "pid,hostname" },
          },
        }
      : {}),
  };
}

export function buildServer(env: Env, options?: BuildServerOptions) {
  const app = Fastify({
    // httpBatchLink packs every procedure name of a batch into ONE path
    // segment; Fastify's 100-char default rejects those with a 414 whose body
    // isn't a tRPC envelope, so the client surfaces "Unable to transform
    // response from server" instead of anything actionable. 工单管理 alone
    // batches 5 procedures / 111 chars.
    routerOptions: { maxParamLength: 5000 },
    // 拓扑上 API 前只有一跳反代（prod 绑 127.0.0.1 仅 nginx 可达，dev 经 vite
    // proxy）：只信任这一跳追加的 XFF 项，左侧更远的项一律视为客户端伪造。
    // fastify 5.11+ 移除了数字形式（hop 计数无法校验对端，fail-closed），
    // 用等价的 trust 函数表达"仅信任最近一跳"。
    trustProxy: (_address, hop) => hop === 0,
    logController: new LogController({ disableRequestLogging: env.NODE_ENV === "development" }),
    logger: buildLoggerOptions(env, options),
    genReqId: () => randomUUID(),
    requestIdHeader: "x-request-id",
  });

  app.addHook("onRequest", (req, _reply, done) => {
    req.log = req.log.child({ traceId: req.id });
    done();
  });

  if (env.NODE_ENV === "development") {
    app.addHook("onRequest", (req, _reply, done) => {
      req.log.debug({ req }, "incoming request");
      done();
    });
    app.addHook("onResponse", (req, reply, done) => {
      req.log.debug({ res: reply, responseTime: reply.elapsedTime }, "request completed");
      done();
    });
  }

  app.register(fastifyCookie, {
    secret: env.SESSION_SECRET,
    hook: "onRequest",
  });

  const sessionService = new SessionService(prisma, env.SESSION_MAX_AGE_SECONDS);
  const authProvider = new PasswordAuthProvider(prisma);

  app.addHook("onRequest", async (req, reply) => {
    const rawCookie = req.cookies.session;
    if (!rawCookie) {
      return;
    }
    const sessionToken = toSessionToken(rawCookie);
    const user = await sessionService.validateSession(sessionToken);
    if (user) {
      req.authenticatedUser = user;
      req.sessionToken = sessionToken;
    } else {
      reply.clearCookie("session");
    }
  });

  app.post("/api/auth/login", async (req, reply) => {
    const parsed = loginBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Username and password required" });
    }
    const { username, password } = parsed.data;

    const userId = await authProvider.authenticate({ username, password });

    if (!userId) {
      return reply.code(401).send({ error: "Invalid username or password" });
    }

    const token = await sessionService.createSession(userId);
    const user = await sessionService.validateSession(token);

    if (!user) {
      return reply.code(500).send({ error: "Failed to create session" });
    }

    reply.setCookie("session", token, {
      httpOnly: true,
      secure: env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: env.SESSION_MAX_AGE_SECONDS,
      path: "/",
    });

    return {
      success: true,
      user: {
        id: user.id,
        username: user.username,
        name: user.name,
        email: user.email,
        roleId: user.roleId,
        roleName: user.roleName,
        permissions: user.permissions,
      },
    };
  });

  app.post("/api/auth/logout", async (req, reply) => {
    if (req.sessionToken) {
      await sessionService.deleteSession(req.sessionToken);
    }
    reply.clearCookie("session");
    return { success: true };
  });

  registerTicketExportRoute(app);
  registerExternalTicketExportRoute(app);
  registerTicketImportTemplateRoute(app);
  registerTicketImportRoute(app);
  registerJbInsurancePushRoute(app, env);
  registerOpenApi(app, env);

  // No CORS plugin: the web app talks to the API same-origin — via the Vite
  // proxy in dev (see apps/web/vite.config.ts) and behind a shared reverse
  // proxy in prod. A cross-origin deployment would add @fastify/cors here.

  app.register(fastifyTRPCPlugin, {
    prefix: "/trpc",
    trpcOptions: {
      router: appRouter,
      createContext,
      onError({ path, error, ctx }) {
        const level =
          error.code === "UNAUTHORIZED"
            ? "debug"
            : error.code === "INTERNAL_SERVER_ERROR"
              ? "error"
              : "warn";
        app.log[level]({ path, traceId: ctx?.traceId, err: error.message }, "tRPC request failed");
      },
    } satisfies FastifyTRPCPluginOptions<AppRouter>["trpcOptions"],
  });

  app.get("/healthz", () => ({ status: "ok" }));

  const openApiPath = resolveOpenApiPath(env);
  app.get("/openapi/workorder-api.yaml", async (_req, reply) => {
    return reply.type("application/yaml").send(await readFile(openApiPath, "utf8"));
  });
  app.register(fastifyApiReference, {
    routePrefix: "/docs",
    openApiDocumentEndpoints: { yaml: "/workorder-api.yaml" },
    configuration: {
      url: "/openapi/workorder-api.yaml",
      hideTestRequestButton: true,
      hideClientButton: true,
    },
  });

  if (env.OPEN_API_ENABLED) {
    app.register(fastifyApiReference, {
      routePrefix: "/docs/analytics",
      configuration: {
        url: "/api/v1/openapi.json",
        hideTestRequestButton: true,
        hideClientButton: true,
      },
    });
  }

  if (env.NODE_ENV === "production") {
    registerStaticFrontend(app, env);
  }

  return app;
}

function resolveWebDistPath(env: Env): string {
  if (env.WEB_DIST_PATH) {
    return resolve(env.WEB_DIST_PATH);
  }
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..", "web", "dist");
}

function resolveOpenApiPath(env: Env): string {
  if (env.OPENAPI_WORKORDER_PATH) {
    return resolve(env.OPENAPI_WORKORDER_PATH);
  }
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..", "..", "docs", "退费异常类工单", "workorder-api.openapi.yaml");
}

function registerStaticFrontend(app: FastifyInstance, env: Env) {
  const root = resolveWebDistPath(env);

  app.register(fastifyStatic, {
    root,
    // @fastify/static 按真实文件逐个注册路由而非 catch-all，不会遮蔽 /trpc/* 与 /healthz。
    wildcard: false,
    index: ["index.html"],
  });

  app.setNotFoundHandler((req, reply) => {
    const isApiPath = req.url.startsWith("/trpc") || req.url.startsWith("/api");
    if (req.method === "GET" && !isApiPath) {
      return reply.code(200).type("text/html").sendFile("index.html");
    }
    return reply.code(404).send({ error: "Not Found" });
  });
}
