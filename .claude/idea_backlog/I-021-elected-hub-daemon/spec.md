---
title: "elected-hub-daemon"
id: I-021
status: idea
---

# elected-hub-daemon

## Acceptance criteria

- [ ] In-process hub election uses atomic `ucsa_bus_hub` epoch takeover; 10 concurrent processes produce exactly 1 hub and 9 connected clients.
- [ ] Unix domain socket transport creates mode 0700/0600 socket and automatically removes stale socket files on dead hub takeover.
- [ ] Windows named pipe transport coordinates IPC with identical semantics on Windows.
- [ ] Client authentication validates random epoch token; invalid token results in immediate `ERROR` frame and disconnect.
- [ ] Slow-consumer protection: queue overflow per client triggers `RESYNC` frame and drops queue without blocking other connected subscribers.
- [ ] CLI command `ucsa daemon` runs the hub service with graceful signal shutdown, and `ucsa status` outputs hub status, epoch, pid, and client count.
