import type {
  ChatMessage,
  Customer,
  Decision,
  FinalState,
  Health,
  MemoryFact,
  PipelineStep,
} from "./types";

export async function getHealth(): Promise<Health> {
  const r = await fetch("/api/health");
  if (!r.ok) throw new Error("health failed");
  return r.json();
}

// ---- live AI-closer ----

export async function listCustomers(): Promise<Customer[]> {
  const r = await fetch("/api/customers");
  return (await r.json()).customers;
}

export async function createCustomer(body: {
  name: string;
  platform: string;
  country?: string;
  category?: string;
}): Promise<Customer> {
  const r = await fetch("/api/customers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json();
}

export async function getCustomer(
  id: string,
): Promise<{ customer: Customer; messages: ChatMessage[]; memory: MemoryFact[] }> {
  const r = await fetch(`/api/customers/${id}`);
  return r.json();
}

export async function sendInbound(
  id: string,
  text: string,
): Promise<{
  decision: Decision;
  sent: ChatMessage[];
  customer: Customer;
  messages: ChatMessage[];
  memory: MemoryFact[];
}> {
  const r = await fetch(`/api/customers/${id}/inbound`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, auto_send: true }),
  });
  return r.json();
}

export async function getSample(): Promise<{ conversation: string; product: string }> {
  const r = await fetch("/api/sample");
  return r.json();
}

export interface StreamHandlers {
  onStart?: (data: { plan: PipelineStep[]; engine: string; retrieval_backend: string }) => void;
  onStep?: (data: { node: string; field: string; result: unknown }) => void;
  onDone?: (data: { state: FinalState }) => void;
  onError?: (msg: string) => void;
}

/** POST /api/run/stream and parse the SSE event stream. */
export async function runStream(
  body: { conversation: string; product: string },
  handlers: StreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const resp = await fetch("/api/run/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!resp.body) throw new Error("no response body");

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() ?? "";
    for (const chunk of chunks) {
      const lines = chunk.split("\n");
      let event = "message";
      let dataLine = "";
      for (const line of lines) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLine += line.slice(5).trim();
      }
      if (!dataLine) continue;
      const data = JSON.parse(dataLine);
      if (event === "start") handlers.onStart?.(data);
      else if (event === "step") handlers.onStep?.(data);
      else if (event === "done") handlers.onDone?.(data);
      else if (event === "error") handlers.onError?.(data.message ?? "unknown error");
    }
  }
}
