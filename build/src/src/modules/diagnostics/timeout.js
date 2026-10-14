/**
 * Resolves or rejects like `promise`, or rejects with "timed out" after `ms`.
 * The work itself is not cancelled; its late result is ignored.
 */
function withTimeout(promise, ms, message = "timed out") {
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(Error(message)), ms);
  });
  return Promise.race([Promise.resolve(promise), timeout]).then(
    value => {
      clearTimeout(timer);
      return value;
    },
    e => {
      clearTimeout(timer);
      throw e;
    }
  );
}

/**
 * Runs `fn` over `items` with at most `limit` at a time
 * @returns {Promise<any[]>} results in the order of `items`
 */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  const workers = [];
  for (let i = 0; i < Math.min(limit, items.length); i++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

const errorMessage = e => {
  if (!e) return "unknown error";
  // fetch: "fetch failed" with the reason in `cause`
  if (e.cause && (e.cause.code || e.cause.message)) {
    return `${e.message}: ${e.cause.code || e.cause.message}`;
  }
  return e.message || String(e);
};

module.exports = { withTimeout, mapLimit, errorMessage };
