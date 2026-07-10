// HTTP client for the crew-bus Worker REST API.

export const USER_AGENT = "crew-bus-mcp (+https://github.com/skyphusion-labs/crew-bus)";

export class CrewBusError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "CrewBusError";
    this.status = status;
  }
}

export interface ClientOptions {
  timeoutMs?: number;
  /** Connect to this IP with Host from base URL (macOS split-DNS workaround). */
  connectIp?: string;
}

export class CrewBusClient {
  private readonly base: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly connectIp?: string;
  private readonly tlsServername?: string;

  constructor(baseUrl: string, token: string, opts: ClientOptions = {}) {
    this.base = baseUrl.replace(/\/+$/, "");
    this.token = token;
    this.timeoutMs = opts.timeoutMs ?? 15000;
    if (opts.connectIp) {
      const parsed = new URL(this.base);
      this.connectIp = opts.connectIp;
      this.tlsServername = parsed.hostname;
    }
  }

  private parseResponse(status: number, text: string): unknown {
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    if (status < 200 || status >= 300) {
      const msg =
        typeof parsed === "object" && parsed && "error" in parsed
          ? String((parsed as { error: unknown }).error)
          : `HTTP ${status}`;
      throw new CrewBusError(msg, status);
    }
    return parsed;
  }

  private requestViaConnectIp(method: string, path: string, body?: unknown): Promise<unknown> {
    const target = new URL(`${this.base}${path}`);
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
      Host: target.host,
    };
    if (payload) headers["Content-Length"] = String(Buffer.byteLength(payload));

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new CrewBusError("request timed out")), this.timeoutMs);
      import("node:https")
        .then(({ request }) => {
          const req = request(
            {
              method,
              hostname: this.connectIp,
              port: target.port || 443,
              path: `${target.pathname}${target.search}`,
              servername: this.tlsServername,
              headers,
            },
            (res) => {
              let text = "";
              res.setEncoding("utf8");
              res.on("data", (chunk) => {
                text += chunk;
              });
              res.on("end", () => {
                clearTimeout(timer);
                try {
                  resolve(this.parseResponse(res.statusCode ?? 500, text));
                } catch (err) {
                  reject(err);
                }
              });
            },
          );
          req.on("error", (err) => {
            clearTimeout(timer);
            reject(err);
          });
          if (payload) req.write(payload);
          req.end();
        })
        .catch((err) => {
          clearTimeout(timer);
          reject(err);
        });
    });
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    if (this.connectIp) {
      return this.requestViaConnectIp(method, path, body);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.base}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
          "User-Agent": USER_AGENT,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const text = await res.text();
      return this.parseResponse(res.status, text);
    } finally {
      clearTimeout(timer);
    }
  }

  send(args: Record<string, unknown>) {
    return this.request("POST", "/api/send", args);
  }

  poll(args: { channel?: string; since?: string; limit?: number; mark_seen?: boolean }) {
    const params = new URLSearchParams();
    if (args.channel) params.set("channel", args.channel);
    if (args.since) params.set("since", args.since);
    if (args.limit !== undefined) params.set("limit", String(args.limit));
    if (args.mark_seen) params.set("mark_seen", "1");
    const q = params.toString();
    return this.request("GET", `/api/poll${q ? `?${q}` : ""}`);
  }

  thread(threadId: string) {
    return this.request("GET", `/api/thread/${encodeURIComponent(threadId)}`);
  }

  ack(messageId: string, body?: string) {
    return this.request("POST", "/api/ack", { message_id: messageId, body });
  }

  channels() {
    return this.request("GET", "/api/channels");
  }

  consumers() {
    return this.request("GET", "/api/consumers");
  }

  markSeen(channel: string, lastSeenAt?: string) {
    return this.request("POST", "/api/mark_seen", {
      channel,
      ...(lastSeenAt ? { last_seen_at: lastSeenAt } : {}),
    });
  }
}
