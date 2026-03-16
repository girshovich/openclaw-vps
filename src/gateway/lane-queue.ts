// Per-session lane queue: ensures messages in the same session are processed
// sequentially. New messages queue behind any currently running turn.

type RunFn = () => Promise<string>;

interface Lane {
  processing: boolean;
  queue: Array<{
    run: RunFn;
    resolve: (text: string) => void;
    reject: (err: unknown) => void;
  }>;
}

const lanes = new Map<string, Lane>();

function getLane(sessionId: string): Lane {
  let lane = lanes.get(sessionId);
  if (!lane) {
    lane = { processing: false, queue: [] };
    lanes.set(sessionId, lane);
  }
  return lane;
}

function processNext(sessionId: string): void {
  const lane = getLane(sessionId);
  const item = lane.queue.shift();
  if (!item) {
    lane.processing = false;
    return;
  }
  lane.processing = true;
  item.run().then(
    (text) => { item.resolve(text); processNext(sessionId); },
    (err: unknown) => { item.reject(err); processNext(sessionId); },
  );
}

export function isLaneActive(sessionId: string): boolean {
  const lane = lanes.get(sessionId);
  return !!lane && (lane.processing || lane.queue.length > 0);
}

export function enqueue(sessionId: string, run: RunFn): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const lane = getLane(sessionId);
    lane.queue.push({ run, resolve, reject });
    if (!lane.processing) processNext(sessionId);
  });
}
