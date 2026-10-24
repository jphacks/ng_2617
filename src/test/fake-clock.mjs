export function fakeClock() {
  let time = 0;
  const tasks = new Set();
  const scheduled = [];
  return {
    now: () => time,
    scheduled,
    pending: () => tasks.size,
    schedule(callback, delay) {
      const task = { callback, at: time + delay };
      tasks.add(task);
      scheduled.push(task);
      return () => tasks.delete(task);
    },
    async advance(ms) {
      const end = time + ms;
      for (let iterations = 0; ; iterations++) {
        if (iterations > 10_000) throw new Error('Timer loop');
        const next = [...tasks].filter(task => task.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        tasks.delete(next);
        time = next.at;
        next.callback();
        await flush();
      }
      time = end;
      await flush();
    },
  };
}

export async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
