import { parentPort, workerData } from "node:worker_threads";

try {
  const data = workerData?.job === "disk"
    ? await (await import("./disk.mjs")).scanDisk({ onProgress: (progress) => parentPort.postMessage({ progress }) })
    : await (await import("./data.mjs")).build();
  parentPort.postMessage({ ok: true, data });
} catch (e) {
  parentPort.postMessage({ ok: false, error: String(e?.message || e) });
}
