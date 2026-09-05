// SSE write observation for the presence room stream (CL-7246 / CL-7212).
// Hono's `StreamingApi.write` awaits `writer.write` inside a bare
// `catch {}`, so a failed or stalled sink never rejects `writeSSE`.
// Bound every write, inspect the writer after it "succeeds", and on
// stall abort the writer rather than awaiting `close()` — that queues
// behind the same in-flight write and never drops the socket.
import type { SSEStreamingApi } from "hono/streaming";
import { reportError } from "@corbits/error-sink";

import { encodeBase64 } from "./base64";
import type { PresenceRoomKey, PresenceRoomRegistry } from "./room-registry";

const DEFAULT_WRITE_TIMEOUT_MS = 10_000;

function underlyingWriterIsErrored(stream: SSEStreamingApi): boolean {
  const writer = Reflect.get(stream, "writer");
  if (typeof writer !== "object" || writer === null) return false;
  if (!("desiredSize" in writer)) return false;
  return writer.desiredSize === null;
}

function abortUnderlyingWriter(stream: SSEStreamingApi): boolean {
  const writer = Reflect.get(stream, "writer");
  if (typeof writer !== "object" || writer === null) return false;
  const abort = Reflect.get(writer, "abort");
  if (typeof abort !== "function") return false;
  try {
    void Promise.resolve(abort.call(writer)).catch(() => undefined);
    return true;
  } catch {
    // report-error-ignore: aborting an already-closed writer is not an incident
    return true;
  }
}

function dropStream(stream: SSEStreamingApi): void {
  const abortedWriter = abortUnderlyingWriter(stream);
  if (typeof stream.abort === "function") {
    stream.abort();
    return;
  }
  if (abortedWriter) return;
  void stream.close().catch(() => undefined);
}

async function writeSSEObservingFailure(
  stream: SSEStreamingApi,
  message: { event?: string; data: string },
  timeoutMs: number,
): Promise<void> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const write = stream.writeSSE(message).then(() => {
    if (stream.aborted || stream.closed || underlyingWriterIsErrored(stream)) {
      throw new Error("presence SSE write failed");
    }
  });
  const stalled = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error("presence SSE write stalled"));
    }, timeoutMs);
  });
  try {
    await Promise.race([write, stalled]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    void write.catch(() => undefined);
  }
}

export interface PresenceStreamBridge {
  teardown: () => void;
  closed: Promise<void>;
}

export function bindPresenceStream(input: {
  stream: SSEStreamingApi;
  registry: Pick<
    PresenceRoomRegistry,
    "subscribe" | "subscribeDocUpdates" | "subscribeSnapshots"
  >;
  key: PresenceRoomKey;
  writeTimeoutMs?: number;
}): PresenceStreamBridge {
  let tornDown = false;
  let resolveClosed: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  let unsubscribePresence: () => void = () => undefined;
  let unsubscribeDoc: () => void = () => undefined;
  let unsubscribeSnapshots: () => void = () => undefined;

  const teardown = () => {
    if (tornDown) return;
    tornDown = true;
    unsubscribePresence();
    unsubscribeDoc();
    unsubscribeSnapshots();
    resolveClosed();
  };

  const writeTimeoutMs = input.writeTimeoutMs ?? DEFAULT_WRITE_TIMEOUT_MS;

  const writeOrTearDown = (message: { event?: string; data: string }) => {
    if (tornDown) return;
    void (async () => {
      try {
        await writeSSEObservingFailure(input.stream, message, writeTimeoutMs);
      } catch (error) {
        if (!(tornDown || input.stream.aborted)) {
          reportError(error, {
            operation: "presence.stream.write",
            tenantId: input.key.tenantId,
            extra: { surface: input.key.surface },
          });
        }
        teardown();
        dropStream(input.stream);
      }
    })();
  };

  unsubscribePresence = input.registry.subscribe(input.key, (states) => {
    writeOrTearDown({
      event: "presence.state",
      data: JSON.stringify(states),
    });
  });
  unsubscribeDoc = input.registry.subscribeDocUpdates(input.key, (update) => {
    writeOrTearDown({
      event: "doc.update",
      data: JSON.stringify({ update: encodeBase64(update) }),
    });
  });
  unsubscribeSnapshots = input.registry.subscribeSnapshots(
    input.key,
    (info) => {
      writeOrTearDown({
        event: "doc.saved",
        data: JSON.stringify(info),
      });
    },
  );

  return { teardown, closed };
}
