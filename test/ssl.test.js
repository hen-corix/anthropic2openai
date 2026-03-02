// SSL/TLS configuration tests for the proxy
// These tests verify that the server starts in HTTPS mode when valid key/cert files are provided
// and falls back to HTTP otherwise.

const { startServer} = require('../index');
const path = require('path');
const fs = require('fs');
const os = require('os');

/** Helper to run the proxy in‑process */
function runProxyInProcess(env, timeout = 5000) {
  return new Promise((resolve) => {
    // Preserve original environment and apply test‑specific variables
    const originalEnv = { ...process.env };
    Object.assign(process.env, env);

    // Capture console output (both log and error)
    const logs = [];
    const origLog = console.log;
    const origError = console.error;
    console.log = (...args) => {
      origLog(args)
      logs.push(args.join(' '));
    }
    console.error = (...args) => {
      origError(args)
      logs.push(args.join(' '));
    }

    // Start the server – it returns the http/https.Server instance
    const server = startServer();

    // Ensure the server is closed after the timeout and restore state
    const timer = setTimeout(() => {
      server.close(() => {
        process.env = originalEnv;
        console.log = origLog;
        console.error = origError;
        resolve({ output: logs.join('\n'), timedOut: true });
      });
    }, timeout);

    // If the server closes earlier (unlikely), clean up immediately
    server.on('close', () => {
      clearTimeout(timer);
      process.env = originalEnv;
      console.log = origLog;
      console.error = origError;
      resolve({ output: logs.join('\n'), timedOut: false });
    });
  });
}

describe('SSL/TLS server startup', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2o-ssl-'));
  const keyPath = path.join(tmpDir, 'key.pem');
  const certPath = path.join(tmpDir, 'cert.pem');

  // Minimal self‑signed PEM files (truncated for brevity)
  const dummyKey = `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQDumf+9XvYRDj2z
AGXQb3pHUArW+LaGx9+IEUjtgUj8jnnl/kiVesiPDvp9d3bm/0MifN+119krjGK/
dq+esMTt0SnTZ+2n8gQlv9ue3SkHwtnaXavPxIMbkgVcynRMf670qfmA1pUtaSib
tCt+jA4HqtITexs0+ngLZ+Cm/k2mMCDAkpt4D4eGx2z6KwnCs/MkOrOuvBkGOMGr
ulQgP6rC1GoXqCP1pex5ATK6N+6oOtYCw8Q3uSAXW8D0EyJHyZ+pzi7/KRC4AKnf
uCSeC4lOIoFAPUitwmPQY6rxzV71UAZ0PS78Evjpq3KYJj/pZSYWDZ+XoX5OKqmy
YIUJLVIBAgMBAAECggEAE6UyXVE4SWc2xUo/F85V7xE0E0cfIDHMwdNKgeOnMsQ4
XSt2pngZk03UaggwDgzuZiSJ9try0pcYelM3WoWLcVlLbFCeTLmshb8qQgZLnov4
i/Yyc0Tm1ppLPrycnr/Uk+h61pTUa4zA/zDyc9TsQs1ZxqjYMKB+ydGfuaAunIQp
OWTcrOo+FBXTqavRI365FO+ElXYNVHLEAUzzCu6Aexcf0y5q0vqhytOm6BoMHN9Y
vWOwxr9YpDVM5L0GY6f3M1MZAWNiwKcKrCm2A06eKsb8YDYLkqvmZwdIw0qQUjRC
0myVZDnlLFFVoSiLmZSwxQTXZgQAHiwk04d4LBgnwQKBgQD8Ay7rGBnW0MqT4arf
k9fmSEudPXO6Fa4Tax8GPPo3P9KO8uz/UkeN2jjTuh4yC4vmlqjSwLS59z46ldVR
b9znUiPhMwFwXDVoapiG5h4YOmN0aFHKgKmgLI4fqU2I8rIb2fiPJsyF/9Oi70b6
FT8MPlBhbsfUmBvwRjdtlx1QDQKBgQDyYH4omtb+ySiyaAn+kYvwmXxk9f8tSnz+
5szRZ3fEqGkkeaRGinCNC3PXU43dru1LC98QF46Uo+na6K7FPDOPAZcfF0kE71md
iKbRqs2uHfBuO9BdsQMUV9iXHdVAPr8T2FnjKcG7riLeJ1h//L7xuFnIjmfjrYFk
nFkeG7OYxQKBgHY9lBzv0OfOTM33urFt74V3dCrRc2Pi2ir4PrUxlQCpLESvy+y7
kSEIO1Nz5sj6S+ij1ZAUpHcAfy0DsfOktZO/IWB/CvTJ/rEAGpJok8QwWQt8Cqwl
k/C4FvLZ/6v6mwCgU5Pu01UnxAeVlsqtf0hiUFp2nMGtoKYqe8UqerFdAoGAKca3
+Ae4RvIlMZr9HgO4OyA5cK117jiIkub1JqLO4falKMROrFnwTF9M+DBOo4cjH2xM
ZlmpGbWm+TRh610VBfEgOxuoWlFnAOAs4Lav/PLsHhPxNjTscvUxP9rEhu5JwQHp
fF4WJmM9X00o0+acgs1jrE3fWj7tronEUowzyIECgYAFxMAKFGopUuuX0aDTfJ0i
QdTi3xU0z4FFGDF5YjQeqFA/aL9H2ggRuyURUk8o0Zi1MVFlyYooBneYY7UohN5A
A9da7FhR077Im54zpoSgLrB/lK91eUY0nP+xadcvppsLuVY+YJxo4GtgI/+Saqpw
/9XOeBVs0gT7tmQHvHHqDg==
-----END PRIVATE KEY-----`;
  const dummyCert = `-----BEGIN CERTIFICATE-----
MIIDCTCCAfGgAwIBAgIUXqQqo+VG3NAoTXBImsGfHYTTumcwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MDIyODE5MjkzOFoXDTI3MDIy
ODE5MjkzOFowFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEA7pn/vV72EQ49swBl0G96R1AK1vi2hsffiBFI7YFI/I55
5f5IlXrIjw76fXd25v9DInzftdfZK4xiv3avnrDE7dEp02ftp/IEJb/bnt0pB8LZ
2l2rz8SDG5IFXMp0TH+u9Kn5gNaVLWkom7QrfowOB6rSE3sbNPp4C2fgpv5NpjAg
wJKbeA+Hhsds+isJwrPzJDqzrrwZBjjBq7pUID+qwtRqF6gj9aXseQEyujfuqDrW
AsPEN7kgF1vA9BMiR8mfqc4u/ykQuACp37gknguJTiKBQD1IrcJj0GOq8c1e9VAG
dD0u/BL46atymCY/6WUmFg2fl6F+TiqpsmCFCS1SAQIDAQABo1MwUTAdBgNVHQ4E
FgQU2qlwsIvW2pCOr5CyPvCcIeueWmEwHwYDVR0jBBgwFoAU2qlwsIvW2pCOr5Cy
PvCcIeueWmEwDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEARKWx
YWwGIfnQxMpXjVFHDXVJdjvyeu6Lw7y7PYSP021CuQzI8hiu5cfre89tT8A9z9Kr
uqPg6wGoSOEBnxKmugTVaQnN5BYyjv1xL3YtjOiverZGldBLrlX8G1f9nXZ59Yso
Nv7mfzdOt+ENXuGVYsg7ph++V7PkH4ViK6m0V8rajQThSLra1xmfr2jsP3gWbu5S
SRFYiZFuK5tB5hfIkKP1DoiuTfc6lJ9QpRGjtlVB8Eo5SvD9tuhP0mxyJRM7s0Ue
4FIDKskIENO4l/eMAg3MhszI46mkcfSHH584fRYYtmiuRPGWY+OXPlBlC2UK6EZE
nK4YMK5xL+7DAm8qUw==
-----END CERTIFICATE-----`;
  fs.writeFileSync(keyPath, dummyKey);
  fs.writeFileSync(certPath, dummyCert);

  afterAll(() => {
    // Clean up temporary files and directory
    try { fs.unlinkSync(keyPath); } catch {}
    try { fs.unlinkSync(certPath); } catch {}
    try { fs.rmdirSync(tmpDir); } catch {}
  });

  test('starts with HTTPS when key and cert are provided', async () => {
    const env = {
      A2O_SSL_KEY_PATH: keyPath,
      A2O_SSL_CERT_PATH: certPath,
      A2O_PROXY_PORT: '3457', // non‑standard port to avoid collisions
      A2O_OPENAI_API_KEY: 'test', // required to avoid early exit
    };
    const { output, timedOut } = await runProxyInProcess(env);
    expect(timedOut).toBe(false);
    expect(output).toMatch(/.*anthropic2openai proxy listening on https:\/\/localhost:3457/i);
  }, 10000);

  test('falls back to HTTP when SSL env vars are missing', async () => {
    const env = {
      A2O_PROXY_PORT: '3458',
      A2O_OPENAI_API_KEY: 'test',
    };
    const { output, timedOut } = await runProxyInProcess(env);
    expect(timedOut).toBe(false);
    expect(output).toMatch(/anthropic2openai proxy listening on http:\/\/localhost:3458/i);
  }, 10000);
});
