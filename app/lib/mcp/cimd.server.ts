import { fetchClientMetadataResource } from "@better-auth/cimd/node";

// The pinned Node transport's DNS lookup cannot itself be aborted. Bound the entire promise,
// including DNS, so a stalled lookup cannot hold the OAuth client mutex indefinitely.
export const fetchMcpClientMetadata: typeof fetchClientMetadataResource = async (input, init) => {
  const controller = new AbortController();
  const upstream = init?.signal ?? (input instanceof Request ? input.signal : undefined);
  const signal = upstream ? AbortSignal.any([controller.signal, upstream]) : controller.signal;
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new DOMException("Client metadata request timed out", "TimeoutError");
      controller.abort(error);
      reject(error);
    }, 3000);
  });
  try { return await Promise.race([fetchClientMetadataResource(input, { ...init, signal }), deadline]); }
  finally { clearTimeout(timer!); }
};
