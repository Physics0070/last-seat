import { randomBytes } from 'node:crypto';

/**
 * In-process pub/sub for server-sent events.
 *
 * Every event gets an id `<bootId>-<seq>`. A reconnecting browser sends the last id it saw
 * (EventSource does this itself via Last-Event-ID); we replay everything newer from a ring buffer.
 * If the id is from another process lifetime or has fallen out of the buffer we cannot know what
 * was missed, so we send `reset` and the client refetches.
 *
 * ponytail: state lives in this process, so this is correct for exactly one instance.
 * Scale-out path: publish to Redis Streams (or tail a MongoDB change stream) and use the stream id as the event id.
 */
export function createEventBus(config) {
  const bootId = randomBytes(4).toString('hex');
  const buffer = [];
  const clients = new Set();
  let seq = 0;

  const frame = (e) => `id: ${bootId}-${e.seq}\ndata: ${e.data}\n\n`;

  function publish(hackathonId, events) {
    for (const event of events) {
      const e = { seq: ++seq, hackathonId: String(hackathonId), data: JSON.stringify({ ...event, at: new Date() }) };
      buffer.push(e);
      if (buffer.length > config.SSE_REPLAY_BUFFER) buffer.shift();
      for (const client of clients) if (client.hackathonId === e.hackathonId) client.res.write(frame(e));
    }
  }

  /** Events newer than lastEventId for this hackathon, or null when continuity cannot be proven. */
  function missedSince(hackathonId, lastEventId) {
    const [boot, raw] = lastEventId.split('-');
    const last = Number(raw);
    const oldest = buffer.length ? buffer[0].seq : seq + 1;
    if (boot !== bootId || !Number.isInteger(last) || last > seq || last < oldest - 1) return null;
    return buffer.filter((e) => e.seq > last && e.hackathonId === hackathonId);
  }

  function subscribe(req, res, hackathonId) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`retry: ${config.SSE_RETRY_MS}\n\n`);

    const client = { res, hackathonId: String(hackathonId) };
    const lastEventId = req.get('Last-Event-ID');
    if (lastEventId) {
      const missed = missedSince(client.hackathonId, lastEventId);
      if (missed) for (const e of missed) res.write(frame(e));
      else res.write('event: reset\ndata: {}\n\n');
    }
    // Registered in the same tick as the replay, so no event can fall between replay and live delivery.
    clients.add(client);

    const heartbeat = setInterval(() => res.write(': ping\n\n'), config.SSE_HEARTBEAT_MS);
    req.on('close', () => {
      clearInterval(heartbeat);
      clients.delete(client);
    });
  }

  function close() {
    for (const client of clients) client.res.end();
  }

  return { publish, subscribe, close, clientCount: () => clients.size };
}
