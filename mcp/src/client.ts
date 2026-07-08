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
}

export class CrewBusClient {
  private readonly base: string;
  private readonly token: string;
  private readonly timeoutMs: number;

  constructor(baseUrl: string, token: string, opts: ClientOptions = {}) {
    this.base = baseUrl.replace(/\/+$/, "");
    this.token = token;
    this.timeoutMs = opts.timeoutMs ?? 15000;
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
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
      let parsed: unknown = null;
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }
      }
      if (!res.ok) {
        const msg =
          typeof parsed === "object" && parsed && "error" in parsed
            ? String((parsed as { error: unknown }).error)
            : `HTTP ${res.status}`;
        throw new CrewBusError(msg, res.status);
      }
      return parsed;
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
}
