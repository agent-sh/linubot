/** Include phases such as DNS and transport startup that do not consume AbortSignal. */
export function abortable<T>(work: Promise<T>, signal: AbortSignal, cancel?: () => void): Promise<T> {
  if (signal.aborted) { cancel?.(); void work.catch(() => {}); return Promise.reject(signal.reason); }
  return new Promise((resolve, reject) => {
    const aborted = () => { cancel?.(); reject(signal.reason); };
    signal.addEventListener("abort", aborted, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}
