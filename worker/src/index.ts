import type { Env } from "./env";
import { handleApi } from "./api";
import { handleMcp } from "./mcp";
import { purgeExpired } from "./store";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname === "/health") {
      return json({ ok: true, service: "crew-bus", version: "0.1.0" });
    }

    if (pathname === "/mcp") {
      return handleMcp(request, env);
    }

    if (pathname.startsWith("/api/")) {
      return handleApi(request, env, pathname);
    }

    return json({ error: "not_found" }, 404);
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      purgeExpired(env.DB, env).then((deleted) => {
        console.log(JSON.stringify({ event: "purge", deleted }));
      }),
    );
  },
} satisfies ExportedHandler<Env>;
