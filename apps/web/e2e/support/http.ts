// Raw HTTP for specs: node:http without keep-alive, so Host and unnormalised paths go out exactly as
// written, and no pooled socket outlives a demo process a spec has stopped. (On Windows, a global fetch
// keep-alive socket to a killed demo makes the Playwright worker hit a libuv assertion when it exits.)
import http from 'node:http';

export interface RawResponse { status: number; headers: http.IncomingHttpHeaders; body: string }

export function rawRequest(origin: string, method: string, path: string, headers: Record<string, string> = {},
  body?: string): Promise<RawResponse> {
  const url = new URL(origin);
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: url.hostname, port: url.port, method, path, headers, agent: false, setHost: !('Host' in headers)
    }, response => {
      let text = '';
      response.setEncoding('utf8').on('data', chunk => { text += chunk; }).on('end', () =>
        resolve({ status: response.statusCode ?? 0, headers: response.headers, body: text }));
    });
    request.on('error', reject);
    request.end(body);
  });
}
