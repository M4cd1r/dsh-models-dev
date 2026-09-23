// test/lan-proxy.test.mjs — the LAN replay regression.
//
// dsh-lan-replay hands every trusted-LAN /api request a Proxy over the request.
// Reading that request's body with `for await (const chunk of req)` (Node's
// stream async iterator) broke in two ways, both fatal to the feature and one
// fatal to the whole host:
//
//   1. the body read never settled — the refresh endpoint hung, so the Models
//      page button did nothing over LAN (no trace, no models updated);
//   2. the next request-stream error (the browser aborting the pending request,
//      e.g. a page reload) threw "TypeError: callback is not a function" from
//      inside the iterator's end-of-stream handler — an uncaught exception that
//      exited the host (watchdog restart, LAN down).
//
// The fixture is a real host stand-in: real http server, the plugin's real
// endpoint, the real proxy shape. A process that dies here would have died as
// the live dsh did.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';

const FIXTURE = fileURLToPath(new URL('./fixtures/lan-proxy-host.mjs', import.meta.url));
const TRUSTED_HOST = '192.168.1.72:3080';
const REFRESH_PATH = '/api/dsh-models-dev/refresh';

let child;
let port;
let stderr = '';

/** One request against the fixture; resolves {status, body} or rejects. */
function request({ body, headers = {}, abort = false, timeoutMs = 4000 }) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error(`no answer within ${timeoutMs} ms (a hung body read looks exactly like this)`));
    }, timeoutMs);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: REFRESH_PATH,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': abort ? Buffer.byteLength(payload) + 50 : Buffer.byteLength(payload),
          host: TRUSTED_HOST,
          origin: `http://${TRUSTED_HOST}`,
          ...headers,
        },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          text += chunk;
        });
        res.on('end', () => {
          clearTimeout(timer);
          resolve({ status: res.statusCode, body: text === '' ? undefined : JSON.parse(text) });
        });
      },
    );
    req.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    req.write(payload);
    if (abort) {
      // The client goes away mid-body: the request stream errors server-side.
      setTimeout(() => req.destroy(), 60);
      clearTimeout(timer);
      resolve({ status: undefined, aborted: true });
    } else {
      req.end();
    }
  });
}

before(async () => {
  child = spawn(process.execPath, [FIXTURE], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  port = await new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`fixture never became ready: ${stderr}`)), 15_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      out += chunk;
      const match = /READY (\d+)/.exec(out);
      if (match !== null) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`fixture exited early with ${code}: ${stderr}`));
    });
  });
});

after(() => {
  child?.kill();
});

test('a trusted-LAN request delivers its body and answers', async () => {
  const answer = await request({ body: { route: 'opencode-go' } });
  assert.equal(answer.status, 200, `expected 200, got ${answer.status} (${stderr})`);
  assert.equal(answer.body.ok, true);
  // The parsed body is what drives the sweep: the trace proves it arrived.
  assert.ok(
    answer.body.log.some((line) => line.includes('routes=opencode-go')),
    `the route from the request body never reached the sweep: ${JSON.stringify(answer.body.log)}`,
  );
});

test('an aborted trusted-LAN request does not take the host down', async () => {
  await request({ body: { route: 'opencode-go' }, abort: true });
  // Give the crash (when there is one) time to land before asking again.
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(child.exitCode, null, `the host died after an aborted request: exit ${child.exitCode}\n${stderr}`);
  const answer = await request({ body: { route: 'opencode-go' } });
  assert.equal(answer.status, 200, `the host stopped answering after an abort (${stderr})`);
  assert.equal(answer.body.ok, true);
});

test('a loopback request is answered the same way', async () => {
  const answer = await request({ body: {}, headers: { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` } });
  assert.equal(answer.status, 200, `expected 200, got ${answer.status} (${stderr})`);
  assert.equal(answer.body.ok, true);
});
