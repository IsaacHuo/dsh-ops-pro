async function selfTest() {
  const health = await runBackend("health", {});
  let snapshot, captureError;
  try {
    snapshot = await runBackend("snapshot",
      { scope: "active_window", includeScreenshot: true, maxDepth: 0, maxNodes: 1, _wcuImageData:true },45000);
  } catch (error) { captureError=error.message; }
  const toolsOk = tools.length >= 10;
  const screenshotBytes = snapshot?.screenshot?.base64 ? Buffer.byteLength(snapshot.screenshot.base64, "base64") : 0;
  const screenshotOk = screenshotBytes > 1000 && snapshot?.screenshot?.mimeType === "image/png";
  return {
    ok: Boolean(health.ok && typeof health.inputDesktopAvailable === "boolean" && toolsOk && screenshotOk && snapshot?.tree),
    server: { name: "windows-computer-use", version: SERVER_VERSION },
    pluginRoot,
    backendPath,
    tools: tools.length,
    inputDesktopAvailable: health.inputDesktopAvailable,
    backend: health,
    screenshot: {
      ok: screenshotOk,
      ...(captureError ? {error:captureError} : {}),
      mimeType: snapshot?.screenshot?.mimeType,
      bytes: screenshotBytes,
      bounds: snapshot?.screenshot?.bounds,
      path: snapshot?.screenshot?.path
    }
  };
}

if (process.argv.includes("--self-test")) {
  installShutdown();
  selfTest()
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
      return shutdown(result.ok ? 0 : 1);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.stack : String(error));
      return shutdown(1);
    });
} else if (process.argv[2] === "--backend") {
  installShutdown();
  const action = process.argv[3] || "health";
  parseBackendCliArgs()
    .then((args) => runBackend(action, args))
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
      return shutdown(0);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.stack : String(error));
      return shutdown(1);
    });
} else if ((() => {
  try {
    const actual = realpathSync(process.argv[1]);
    const own = realpathSync(fileURLToPath(import.meta.url));
    return process.platform === 'win32' ? actual.toLowerCase() === own.toLowerCase() : actual === own;
  } catch { return false; }
})()) {
  installShutdown();
  process.stdin.on("data", (chunk) => {
    try {
      ingest(chunk);
    } catch (error) {
      send(rpcError(null, -32700, error instanceof Error ? error.message : String(error)));
    }
  });
  process.stdin.on("end", () => {
    stdinEnded = true;
    maybeExitAfterStdinEnd();
  });
  process.stderr.write(`windows-computer-use MCP server ${SERVER_VERSION} ready\n`);
}

let pendingRequests = 0;
let stdinEnded = false;
let shuttingDown;

function installShutdown() {
  process.once('SIGINT', () => { void shutdown(130); });
  process.once('SIGTERM', () => { void shutdown(143); });
  process.on('exit', () => { killBackends(); void ownedHiddenDesktop?.dispose(); browserLane.close(); takeover.child?.kill(); });
}

function shutdown(code) {
  if (!shuttingDown) {
    process.stdin.pause();
    killBackends();
    void ownedHiddenDesktop?.dispose();
    shuttingDown = Promise.allSettled([takeover.close(), browserLane.shutdown()]).then(() => process.exit(code));
  }
  return shuttingDown;
}

function maybeExitAfterStdinEnd() {
  if (stdinEnded && pendingRequests === 0) {
    // A kept-profile DSH browser closes itself first, saving its last cookies.
    void shutdown(0);
  }
}

async function parseBackendCliArgs() {
  const rawArg = process.argv.slice(4).join(" ").trim();
  if (rawArg) {
    return JSON.parse(rawArg);
  }
  if (process.stdin.isTTY) {
    return {};
  }
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  const rawStdin = Buffer.concat(chunks).toString("utf8").trim();
  return rawStdin ? JSON.parse(rawStdin) : {};
}
