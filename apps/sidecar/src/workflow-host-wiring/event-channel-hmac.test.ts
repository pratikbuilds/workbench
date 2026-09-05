// CL-6396: a body child's stamped `childRunId` is inside the HMAC-signed
// envelope, not a sidecar-side annotation after verify. This roundtrip
// is the production event-channel path (`encodeEnvelope` → HMAC →
// `receiveEventChannel` → `ReceivedEvent`), so a missing field cannot
// hide behind an in-process object that never went over the wire.
import { expect, test } from "bun:test";
import {
  createEventChannelSender,
  decodeEnvelope,
  encodeEnvelope,
  generateChannelId,
  generateHmacKey,
  receiveEventChannel,
  type EventPayload,
  type FrameReader,
  type FrameWriter,
} from "@intx/workflow-host";

const EVENT = {
  type: "inference.start" as const,
  seq: 1,
  data: { model: "stub" },
};

function createMemoryPipe(): {
  writer: FrameWriter;
  reader: FrameReader;
  close: () => void;
} {
  const chunks: Uint8Array[] = [];
  let closed = false;
  let wake: (() => void) | null = null;
  function notify() {
    const waiting = wake;
    wake = null;
    waiting?.();
  }
  return {
    writer: {
      write(bytes) {
        chunks.push(bytes);
        notify();
      },
    },
    reader: {
      async *read() {
        for (;;) {
          while (chunks.length > 0) {
            const next = chunks.shift();
            if (next !== undefined) yield next;
          }
          if (closed) return;
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
      },
    },
    close() {
      closed = true;
      notify();
    },
  };
}

test("stamped childRunId survives encodeEnvelope, HMAC verify, and ReceivedEvent", async () => {
  const hmacKey = generateHmacKey();
  const channelId = generateChannelId();
  const envelopeBytes = encodeEnvelope({
    seq: 1,
    channelId,
    payload: EVENT,
    childRunId: "turn__0",
  });
  expect(decodeEnvelope(envelopeBytes).childRunId).toBe("turn__0");

  const pipe = createMemoryPipe();
  const sender = createEventChannelSender({
    hmacKey,
    channelId,
    writer: pipe.writer,
  });
  const received: { event: EventPayload; childRunId?: string }[] = [];
  const crashes: string[] = [];
  const consume = (async () => {
    for await (const frame of receiveEventChannel({
      hmacKey,
      channelId,
      reader: pipe.reader,
      onCrash: (reason) => crashes.push(reason),
    })) {
      received.push(frame);
    }
  })();

  await sender.send(EVENT, "turn__0");
  const deadline = Date.now() + 2_000;
  while (received.length === 0) {
    if (crashes.length > 0) {
      throw new Error(`event channel crashed: ${crashes.join("; ")}`);
    }
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for HMAC-verified event");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  pipe.close();
  await consume;

  expect(crashes).toEqual([]);
  expect(received).toEqual([{ event: EVENT, childRunId: "turn__0" }]);
});
